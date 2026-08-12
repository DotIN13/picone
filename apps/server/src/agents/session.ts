import { randomUUID } from "node:crypto";
import type {
  AgentCapabilities,
  AgentEvent,
  AgentKind,
  AgentState,
  ChatItem,
  ContextUsage,
  ExtensionUiAnswer,
  FileComment,
  ModelOption,
  PermissionDecision,
  ResourceReport,
  SessionModel,
  SessionSummary,
  SlashCommand,
  Workspace,
} from "@picone/protocol";
import { appendMessage, loadTranscriptTail, nextSeq, truncateTranscript } from "../db.ts";
import { commentContext } from "../comments/matcher.ts";
import { memorySubjects, mentionContext } from "../memory/subjects.ts";
import { PermissionGate } from "../permissions/gate.ts";
import { resolvedPermissions } from "../workspace/schema.ts";
import type { AgentBackend, AgentHost, AgentServices } from "./backend.ts";
import { createBackend } from "./registry.ts";
import { EventTranslator } from "./translator.ts";

/** What a session is called before anything has named it. */
export const DEFAULT_TITLE = "New session";

/** What each agent is called where a human reads it — a permission card, mostly. */
export const AGENT_NAMES: Record<AgentKind, string> = { pi: "Pi", claude: "Claude" };

/**
 * How much of a session is held in memory and sent on connect. Larger than the
 * browser's own window so scrolling back a page usually costs nothing.
 */
const TAIL = 120;

export interface SessionRuntimeOptions {
  id: string;
  title: string;
  /** Which agent is behind it (§57). */
  agent: AgentKind;
  workspace: Workspace;
  /** A session file or id from a previous run, if this session already ran. */
  resumeRef?: string;
  emit: (sessionId: string, event: AgentEvent) => void;
  services: AgentServices;
  /** The comment surface (§16), which is the app's rather than the agent's. */
  comments: {
    resolve(commentId: string): FileComment | null;
    open(): FileComment[];
  };
  onResumeRef: (sessionId: string, ref: string) => void;
  /** The session's name changed, from either side of the agent boundary (§26). */
  onTitle: (sessionId: string, title: string) => void;
  /** The transcript grew, so anything summarising it is now stale (§27). */
  onActivity: (sessionId: string) => void;
}

/**
 * One session, and the world around whichever agent is having it (DESIGN §8).
 *
 * Everything here is Picone's rather than the agent's: the transcript and its
 * rows in the database, the permission gate, the title, what a message picks up
 * on the way past (§16, §52). The conversation itself — history, context,
 * compaction, tool execution — belongs entirely to the backend, and this class
 * only supplies the environment around it and translates both directions.
 *
 * It was one class with Pi inside it until there were two agents to hold.
 */
export class SessionRuntime {
  readonly id: string;
  readonly agent: AgentKind;
  title: string;
  readonly createdAt = new Date().toISOString();
  updatedAt = this.createdAt;

  /** Replaced when the workspace file is edited, so roots never go stale. */
  private workspace: Workspace;
  private backend!: AgentBackend;
  private translator!: EventTranslator;
  private gate!: PermissionGate;
  private editorText = "";

  /**
   * The tail of the transcript, not all of it (DESIGN §14). Older pages live in
   * the database and are fetched when the browser scrolls back to them.
   */
  private transcript: ChatItem[] = [];
  /**
   * Whether the tail above is the whole conversation or the end of a longer one.
   *
   * Known here for free — the page that loaded the tail said so — and worth
   * passing on: the browser otherwise has to offer "earlier messages" on every
   * session, including a new one where the button does nothing at all.
   */
  private hasEarlier = false;
  /** `seq` of `transcript[0]`, so a row's number survives not holding the rest. */
  private baseSeq = 0;
  /** Next free `seq`, read from the table rather than counted from memory. */
  private seq = 0;
  private readonly pending = new Map<
    string,
    { resolve: (decision: PermissionDecision) => void; itemId: string }
  >();

  constructor(private readonly options: SessionRuntimeOptions) {
    this.id = options.id;
    this.agent = options.agent;
    this.title = options.title;
    this.workspace = options.workspace;
  }

  static async create(options: SessionRuntimeOptions): Promise<SessionRuntime> {
    const runtime = new SessionRuntime(options);
    await runtime.init();
    return runtime;
  }

  private async init(): Promise<void> {
    const workspace = this.workspace;
    /*
     * The workspace says where to work (§3). Falling back to a context
     * directory matters when the cwd is missing — a workspace file shared from
     * another machine still opens somewhere sensible rather than in whatever
     * directory the server happened to start in. A memory directory is
     * readable, but it is not where work happens.
     */
    const cwd =
      workspace.roots.find((r) => r.exists && r.kind === "cwd")?.path ??
      workspace.roots.find((r) => r.exists && r.kind === "context")?.path ??
      process.cwd();

    const tail = loadTranscriptTail(this.id, TAIL);
    this.transcript = tail.items;
    this.baseSeq = tail.firstSeq;
    this.hasEarlier = tail.hasMore;
    this.seq = nextSeq(this.id);

    this.translator = new EventTranslator({
      emit: (event) => this.options.emit(this.id, event),
      commit: (item) => this.commit(item),
      renamed: (name) => this.adoptName(name),
    });

    this.gate = new PermissionGate(
      resolvedPermissions(workspace.file),
      {
        ask: (request) =>
          new Promise<PermissionDecision>((resolve) => {
            const item: ChatItem = { kind: "permission", id: request.id, request, at: new Date().toISOString() };
            this.commit(item);
            this.translator.setState("waiting_permission");
            this.pending.set(request.id, { resolve, itemId: request.id });
            this.options.emit(this.id, { type: "permission.requested", request });
          }),
      },
      {
        cwd,
        agent: AGENT_NAMES[this.agent],
        // Read live rather than captured: adding a directory to the workspace,
        // or making a memory store writable, has to take effect without
        // rebuilding the session.
        roots: () => this.workspace.roots,
      },
    );

    const host: AgentHost = {
      sessionId: this.id,
      translator: this.translator,
      emit: (event) => this.options.emit(this.id, event),
      askPermission: (toolName, input) => this.gate.check(toolName, input),
      editorText: () => this.editorText,
      openComments: () => this.options.comments.open(),
      resolveComment: (commentId) => this.options.comments.resolve(commentId),
      speak: (text) => this.options.emit(this.id, { type: "voice.speak", text }),
      userMessages: () =>
        this.transcript
          .filter((item): item is Extract<ChatItem, { kind: "user" }> => item.kind === "user")
          .map((item) => ({ id: item.id, text: item.text, entryId: item.entryId })),
      tagEntry: (itemId, entryId) => this.tagEntry(itemId, entryId),
    };

    this.backend = await createBackend(this.agent, {
      id: this.id,
      workspace,
      cwd,
      resumeRef: this.options.resumeRef,
      host,
      services: this.options.services,
    });

    this.rememberResumeRef();
    this.backend.syncEntryIds?.();
    this.publishContext();
    this.reconcileName();
  }

  // --- what the app asks of a session ----------------------------------------

  get capabilities(): AgentCapabilities {
    return this.backend.capabilities;
  }

  /** Resolve a blocking extension dialog with the human's answer (§55). */
  answerExtensionUi(answer: ExtensionUiAnswer): void {
    this.backend.extensionUi?.answer(answer);
  }

  keyExtensionUi(id: string, data: string): void {
    this.backend.extensionUi?.key(id, data);
  }

  /** Mirror of the browser composer, so `getEditorText()` returns something real. */
  setEditorText(text: string): void {
    this.editorText = text;
  }

  /**
   * `displayText` lets the transcript stay readable when the model-facing text
   * is a long structured block — a file comment, for instance.
   */
  async prompt(text: string, source: "chat" | "voice" | "comment" = "chat", displayText?: string): Promise<void> {
    if (!text.trim()) return;
    this.recordUserMessage(displayText ?? text, source);

    try {
      await this.backend.prompt(this.withMentions(text));
    } catch (err) {
      this.translator.notice(`Prompt failed: ${(err as Error).message}`, "error");
      this.translator.setState("idle");
    }

    this.afterTurn();
  }

  /** Explicit steering — used by voice and comments during an active run. */
  async steer(text: string, source: "chat" | "voice" | "comment" = "chat", displayText?: string): Promise<void> {
    if (!this.backend.isStreaming) {
      await this.prompt(text, source, displayText);
      return;
    }
    this.recordUserMessage(displayText ?? text, source);
    try {
      await this.backend.steer(this.withMentions(text));
    } catch (err) {
      this.translator.notice(`Steering failed: ${(err as Error).message}`, "error");
    }
    this.afterTurn();
  }

  /** The transcript keeps what was typed; only the model-facing copy grows. */
  private recordUserMessage(shown: string, source: "chat" | "voice" | "comment"): void {
    const item: ChatItem = { kind: "user", id: randomUUID(), text: shown, source, at: new Date().toISOString() };
    this.commit(item);
    this.options.emit(this.id, { type: "user.message", id: item.id, text: shown, source, at: item.at });
  }

  private afterTurn(): void {
    // A session becomes resumable once it has said something: Pi writes its
    // file on the first reply, and Claude's id is only good after a turn.
    this.rememberResumeRef();
    this.backend.syncEntryIds?.();
    if (this.entriesTagged) {
      this.entriesTagged = false;
      this.options.emit(this.id, this.snapshot());
    }
    void this.publishContext();
  }

  /**
   * What the agent receives on top of what was typed (§57, §16).
   *
   * Two additions, both about things the message names rather than describes: a
   * pointer to any memory subject it mentions, and the open comments on any
   * file it names. Appended rather than woven in, and kept out of the
   * transcript, so what the reader sees is what they wrote.
   */
  private withMentions(text: string): string {
    const comments = commentContext(text, this.options.comments.open());
    if (comments) text = `${text}

---

${comments}`;
    const pointers = mentionContext(text, memorySubjects(this.workspace.memory));
    return pointers ? `${text}

---

${pointers}` : text;
  }

  async abort(): Promise<void> {
    await this.backend.abort();
    this.translator.flush();
    this.translator.setState("idle");
  }

  respondToPermission(requestId: string, decision: PermissionDecision): void {
    const entry = this.pending.get(requestId);
    if (!entry) return;
    this.pending.delete(requestId);

    const item = this.transcript.find((i) => i.id === entry.itemId);
    if (item?.kind === "permission") {
      item.decision = decision;
      appendMessage(this.id, this.seqOf(item), item);
    }

    this.options.emit(this.id, { type: "permission.resolved", requestId, decision });
    this.translator.setState("thinking");
    entry.resolve(decision);
  }

  /**
   * Deliver a file comment as ordinary session input (DESIGN §19/§20).
   * If the agent is working it steers; otherwise it is just the next message.
   */
  async injectComment(modelText: string, displayText: string): Promise<void> {
    if (this.backend.isStreaming) await this.steer(modelText, "comment", displayText);
    else await this.prompt(modelText, "comment", displayText);
  }

  // --- context and compaction (DESIGN §54) -----------------------------------

  /**
   * Re-read everything a session was built with (DESIGN §34).
   *
   * An agent assembles its system prompt once — the workspace description, the
   * skills, the memory stores' instructions — and caches it, so an edit made
   * afterwards is invisible to a running session.
   */
  async reloadResources(): Promise<void> {
    if (!this.backend.reload) {
      this.translator.notice("This agent has nothing to reload.", "info");
      return;
    }
    await this.backend.reload();
    this.translator.notice("Reloaded: skills, extensions and the workspace description are current again.", "info");
    await this.publishContext();
  }

  /**
   * What the session has cost so far, from the agent's own tally (DESIGN §36).
   *
   * It goes in as a notice: it is an answer to a question the human asked, and
   * no business of the agent's.
   */
  async reportStats(): Promise<void> {
    const lines = await this.backend.statsLines();
    this.translator.notice(lines.join("\n"), "info");
  }

  /** Write the session out as HTML, through the agent's own exporter. */
  async exportHtml(): Promise<void> {
    if (!this.backend.exportHtml) {
      this.translator.notice("This agent cannot export a session.", "info");
      return;
    }
    try {
      const path = await this.backend.exportHtml();
      this.translator.notice(`Exported to ${path}`, "info");
    } catch (err) {
      this.translator.notice(`Could not export: ${(err as Error).message}`, "error");
    }
  }

  async compact(): Promise<void> {
    if (!this.backend.compact) {
      this.translator.notice("This agent compacts on its own; there is nothing to ask for.", "info");
      return;
    }
    try {
      await this.backend.compact();
    } catch (err) {
      this.translator.notice(`Could not compact: ${(err as Error).message}`, "error");
    }
    await this.publishContext();
  }

  /** Whether the agent compacts on its own when the context fills (§54). */
  get autoCompaction(): boolean {
    return this.backend.autoCompaction?.get() ?? true;
  }

  setAutoCompaction(enabled: boolean): void {
    this.backend.autoCompaction?.set(enabled);
  }

  /**
   * Say how full the context is, whenever it can have changed.
   *
   * Sampled at the moments that move it — a turn ending, a compaction ending, a
   * session being opened — rather than watched, because both agents offer it as
   * a reading rather than an event. It is also sampled whenever a transcript is
   * pushed, which is what makes it survive a reload: a browser that reconnects
   * to an already-open session has missed every change so far.
   */
  async publishContext(): Promise<void> {
    let usage: ContextUsage | null = null;
    try {
      usage = await this.backend.contextUsage();
    } catch {
      // A reading is not worth an error in the transcript.
    }
    this.options.emit(this.id, { type: "context.usage", usage });
  }

  // --- the session name (DESIGN §26) -----------------------------------------

  /**
   * An agent that keeps its own name for a session and ours have to be kept in
   * step, or a rename in a terminal is invisible here and a rename here never
   * reaches the file. The agent's wins when it has an opinion: it is the shared
   * artifact, and whatever the session is called there is what it is called.
   */
  private reconcileName(): void {
    const theirs = this.backend.agentName?.();
    if (theirs) {
      if (theirs !== this.title) this.applyTitle(theirs);
      return;
    }
    if (this.title && this.title !== DEFAULT_TITLE) this.backend.rename?.(this.title);
  }

  /** The agent's name changed — from `/name`, an extension, or our own rename. */
  private adoptName(name: string | undefined): void {
    // An empty name clears the title in Pi. Ours has to say something, so it
    // falls back to the placeholder rather than becoming blank.
    this.applyTitle(name || DEFAULT_TITLE);
  }

  private applyTitle(title: string): void {
    if (this.title === title) return;
    this.title = title;
    this.options.onTitle(this.id, title);
  }

  /**
   * Rename from Picone. An agent may sanitize — newlines become spaces, and it
   * is trimmed — so the stored title comes back from the agent rather than from
   * the caller, and the two cannot drift apart on a technicality.
   */
  rename(title: string): string {
    return this.backend.rename?.(title) || title;
  }

  // --- the session tree (DESIGN §53) -----------------------------------------

  /** Where a rewind or a fork can start: user messages we have an entry for. */
  private entryFor(itemId: string): { entryId: string; index: number } {
    const index = this.transcript.findIndex((i) => i.id === itemId);
    const item = this.transcript[index];
    if (!item || item.kind !== "user" || !item.entryId) {
      throw new Error("That message cannot be rewound to — it predates session-tree support.");
    }
    return { entryId: item.entryId, index };
  }

  /**
   * Move the leaf back to just before a message, in the same session.
   *
   * The agent does the real work; our transcript is not its (§37), so it is
   * truncated to match — everything from the rewound message onwards belongs to
   * the branch just left.
   */
  async rewind(itemId: string): Promise<void> {
    if (!this.backend.rewindTo) throw new Error("This agent cannot rewind a conversation.");
    if (this.backend.isStreaming) throw new Error("Stop the agent before rewinding.");
    const { entryId, index } = this.entryFor(itemId);

    const dropped = this.transcript.length - index;
    const result = await this.backend.rewindTo(entryId);
    if (result.cancelled) return;

    this.truncateTo(index);

    // Say what happened to the messages that vanished. Picone cannot switch
    // between branches yet, and quietly removing work from the screen while
    // leaving it on disk is the kind of thing a user finds out about by
    // accident. One line, where they are already looking.
    this.translator.notice(
      dropped === 1
        ? "Rewound. The message after this point is kept on a branch of its own in the session file."
        : `Rewound. The ${dropped} messages after this point are kept on a branch of their own in the session file.`,
      "info",
    );

    this.options.emit(this.id, this.snapshot());
    if (result.editorText) this.options.emit(this.id, { type: "editor.set", text: result.editorText });
  }

  /** The same point, in a session of its own (§53). */
  forkPoint(itemId: string): { resumeRef: string | null; text: string; history: ChatItem[] } {
    if (!this.backend.forkFrom) throw new Error("This agent cannot fork a conversation.");
    const { entryId, index } = this.entryFor(itemId);
    const item = this.transcript[index];
    const text = item?.kind === "user" ? item.text : "";
    // The agent carries the history in the branched session; this is the
    // browser's copy of the same thing (§37). Entry ids survive the branch, so
    // the forked messages stay rewindable too.
    const history = this.transcript.slice(0, index).map((entry) => structuredClone(entry));
    const { resumeRef } = this.backend.forkFrom(entryId);
    return { resumeRef, text, history };
  }

  /**
   * The workspace file changed. Permissions and the writable roots both come
   * from it, so they are refreshed together rather than drifting apart.
   */
  updateWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    this.gate.updatePermissions(resolvedPermissions(workspace.file));
    this.backend.updateWorkspace(workspace);
  }

  /**
   * Swap the model on the live session (DESIGN §41: the agent owns the loop, we
   * only drive it). Takes effect on the next turn, mid-conversation.
   */
  async setModel(provider: string, model: string, thinking?: string): Promise<void> {
    await this.backend.setModel(provider, model, thinking);
    this.translator.notice(`Model switched to ${model}.`, "info");
  }

  currentModel(): SessionModel | undefined {
    return this.backend?.model();
  }

  /** The models this session's agent offers, when it is the only source (§57). */
  modelOptions(): ModelOption[] {
    return this.backend?.modelOptions?.() ?? [];
  }

  /** Slash commands the agent knows about in this session. */
  commands(): SlashCommand[] {
    return this.backend?.commands() ?? [];
  }

  /** What the agent discovered for this session — the browser's only view of it. */
  resources(): ResourceReport | null {
    return this.backend?.resources() ?? null;
  }

  // --- outbound --------------------------------------------------------------

  get state(): AgentState {
    return this.translator.getState();
  }

  get isStreaming(): boolean {
    return this.backend?.isStreaming ?? false;
  }

  get resumeRef(): string | undefined {
    return this.backend?.resumeRef();
  }

  snapshot(): AgentEvent {
    return {
      type: "session.snapshot",
      sessionId: this.id,
      items: this.transcript,
      state: this.state,
      hasMore: this.hasEarlier,
    };
  }

  /** Set once, when this session was forked from another (DESIGN §53). */
  forkedFrom?: string;

  summary(): SessionSummary {
    const ref = this.resumeRef;
    return {
      id: this.id,
      title: this.title,
      agent: this.agent,
      capabilities: this.backend?.capabilities,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      resumeRef: ref,
      // Pi's word for the same thing, kept so nothing that reads it breaks.
      sessionFile: this.agent === "pi" ? ref : undefined,
      model: this.currentModel(),
      forkedFrom: this.forkedFrom,
    };
  }

  notice(text: string, level: "info" | "warn" | "error" = "info"): void {
    this.translator.notice(text, level);
  }

  dispose(): void {
    for (const [, entry] of this.pending) entry.resolve("deny");
    this.pending.clear();
    this.backend?.dispose();
  }

  /**
   * Give a freshly forked session the conversation it inherited (DESIGN §53).
   * The agent already has it; this is the browser's copy.
   */
  seedTranscript(items: ChatItem[]): void {
    this.transcript = items;
    this.baseSeq = 0;
    this.seq = items.length;
    items.forEach((item, index) => appendMessage(this.id, index, item));
  }

  /** The last handle written to the database, so it is written once. */
  private storedRef: string | undefined;

  private rememberResumeRef(): void {
    const ref = this.backend?.resumeRef();
    if (!ref || ref === this.storedRef) return;
    this.storedRef = ref;
    this.options.onResumeRef(this.id, ref);
  }

  /**
   * Record which agent-side entry a message became (§53), and remember that
   * something changed so the browser is told once rather than per message.
   */
  private entriesTagged = false;

  private tagEntry(itemId: string, entryId: string): void {
    const item = this.transcript.find((i) => i.id === itemId);
    if (!item || item.kind !== "user" || item.entryId === entryId) return;
    item.entryId = entryId;
    appendMessage(this.id, this.seqOf(item), item);
    this.entriesTagged = true;
  }

  /** Where a held item sits in the table. */
  private seqOf(item: ChatItem): number {
    return this.baseSeq + this.transcript.indexOf(item);
  }

  /** Forget the transcript from `index` on, in memory and on disk. */
  private truncateTo(index: number): void {
    const seq = this.baseSeq + index;
    this.transcript.length = index;
    this.seq = seq;
    truncateTranscript(this.id, seq);
  }

  private commit(item: ChatItem): void {
    const existing = this.transcript.findIndex((i) => i.id === item.id);
    if (existing >= 0) {
      this.transcript[existing] = item;
      appendMessage(this.id, existing, item);
    } else {
      this.transcript.push(item);
      appendMessage(this.id, this.seq++, item);
    }
    this.updatedAt = new Date().toISOString();
    // The session list shows an excerpt of this and orders by its timestamp,
    // so it is stale the moment anything lands (§27).
    this.options.onActivity(this.id);
  }
}
