import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  type AgentSession,
  type InlineExtension,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentEvent,
  AgentState,
  ChatItem,
  ExtensionUiAnswer,
  PermissionDecision,
  ResourceInfo,
  ResourceReport,
  SessionModel,
  SessionSummary,
  SlashCommand,
  Workspace,
  WorkspacePermissions,
  WorkspaceResources,
} from "@picone/protocol";
import { appendMessage, loadTranscriptTail, nextSeq, truncateTranscript } from "../db.ts";
import { memoryContextFiles } from "../memory/context.ts";
import { commentContext } from "../comments/matcher.ts";
import { memorySubjects, mentionContext } from "../memory/subjects.ts";
import { PermissionGate } from "../permissions/gate.ts";
import { resolvedPermissions, resolvedVoice } from "../workspace/schema.ts";
import { resolveSkillPaths, workspaceContext } from "../workspace/loader.ts";
import { EventTranslator } from "./events.ts";
import { ExtensionUiBridge } from "./extension-ui.ts";
import { createCommentTools, createSpeakTool, type PiconeToolHooks } from "./tools.ts";

/**
 * Pi identifies extensions by path. The basename is usually what a human
 * recognises — except for npm packages, which all resolve to `index.ts`, so
 * those fall back to the directory name.
 */
function extensionName(extension: { path: string; resolvedPath?: string }): string {
  const source = extension.resolvedPath || extension.path;
  const segments = source.split(/[/\\]/).filter(Boolean);
  const base = (segments.pop() ?? source).replace(/\.(ts|js|mjs|cjs|tsx)$/, "");
  if (base !== "index") return base;

  // ".../pi-subagents/index.ts" → "pi-subagents", and ".../pi-x/src/index.ts"
  // → "pi-x": climb past build directories, and keep an npm scope if present.
  const BUILD_DIRS = new Set(["src", "dist", "lib", "build", "out"]);
  let parent = segments.pop() ?? base;
  while (BUILD_DIRS.has(parent) && segments.length > 0) parent = segments.pop()!;

  const grandparent = segments[segments.length - 1];
  return grandparent?.startsWith("@") ? `${grandparent}/${parent}` : parent;
}

/** Our own permission hook is not something the user should switch off. */
function isInternalExtension(extension: { path: string }): boolean {
  return extension.path.startsWith("<inline:");
}

/** Pi reports extension failures as a structured record, not a string. */
function formatExtensionError(error: unknown): string {
  if (typeof error === "string") return `Extension error: ${error}`;
  if (error instanceof Error) return `Extension error: ${error.message}`;
  if (error && typeof error === "object") {
    const { extensionPath, event, error: detail } = error as Record<string, unknown>;
    const where = [extensionPath, event].filter(Boolean).join(" · ");
    const message = detail instanceof Error ? detail.message : typeof detail === "string" ? detail : undefined;
    return `Extension error${where ? ` (${where})` : ""}: ${message ?? JSON.stringify(detail ?? error)}`;
  }
  return `Extension error: ${String(error)}`;
}

/** What a session is called before anything has named it. */
export const DEFAULT_TITLE = "New session";

/**
 * How much of a session is held in memory and sent on connect. Larger than the
 * browser's own window so scrolling back a page usually costs nothing.
 */
const TAIL = 120;

export interface SessionRuntimeOptions {
  id: string;
  title: string;
  workspace: Workspace;
  /** Existing Pi session file to resume, if this app session already ran. */
  sessionFile?: string;
  emit: (sessionId: string, event: AgentEvent) => void;
  extraTools: () => ToolDefinition[];
  /** Skill directories from global settings, on top of the workspace's own. */
  globalSkillPaths: string[];
  toolHooks: Omit<PiconeToolHooks, "speak">;
  onSessionFile: (sessionId: string, file: string) => void;
  /** The session's name changed, from either side of the Pi boundary (§26). */
  onTitle: (sessionId: string, title: string) => void;
  /** The transcript grew, so anything summarising it is now stale (§27). */
  onActivity: (sessionId: string) => void;
}

/**
 * One Pi session behind one Picone session (DESIGN §8, §26).
 *
 * Everything Pi owns — history, context, compaction, tool execution — stays
 * inside `AgentSession`. This class only supplies the environment around it and
 * translates both directions.
 */
export class SessionRuntime {
  readonly id: string;
  title: string;
  readonly createdAt = new Date().toISOString();
  updatedAt = this.createdAt;

  /** Replaced when the workspace file is edited, so roots never go stale. */
  private workspace: Workspace;
  private session!: AgentSession;
  private translator!: EventTranslator;
  private gate!: PermissionGate;
  private unsubscribe: (() => void) | null = null;
  private modelRuntime!: ModelRuntime;
  /** Captured from the extension context; the only accessor for slash commands. */
  private getPiCommands: (() => SlashCommand[]) | null = null;
  private editorText = "";
  private resourceLoader: DefaultResourceLoader | null = null;
  private readonly extensionUi: ExtensionUiBridge;
  /**
   * Everything Pi found, captured before the workspace's switches are applied —
   * the loader only keeps what survived, and the settings panel has to show
   * what was switched off in order to switch it back on.
   */
  private discovered: ResourceReport = { extensions: [], skills: [], prompts: [] };

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
    this.title = options.title;
    this.workspace = options.workspace;
    this.extensionUi = new ExtensionUiBridge({
      prompt: (prompt) => this.options.emit(this.id, { type: "extension.ui.prompt", prompt }),
      closePrompt: (id) => this.options.emit(this.id, { type: "extension.ui.prompt.closed", id }),
      update: (update) => this.options.emit(this.id, { type: "extension.ui.update", update }),
      frame: (id, lines) => this.options.emit(this.id, { type: "extension.ui.frame", id, lines }),
      notify: (message, level) => this.translator.notice(message, level),
      editorText: () => this.editorText,
    });
  }

  static async create(options: SessionRuntimeOptions): Promise<SessionRuntime> {
    const runtime = new SessionRuntime(options);
    await runtime.init();
    return runtime;
  }

  private async init(): Promise<void> {
    const workspace = this.workspace;
    // A memory directory is readable, but it is not where work happens.
    /*
     * The workspace says where to work (§3). Falling back to a context
     * directory matters when the cwd is missing — a workspace file shared from
     * another machine still opens somewhere sensible rather than in whatever
     * directory the server happened to start in.
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
        // Read live rather than captured: adding a directory to the workspace,
        // or making a memory store writable, has to take effect without
        // rebuilding the session.
        roots: () => this.workspace.roots,
      },
    );

    const permissionExtension: InlineExtension = {
      name: "picone-permissions",
      factory: (pi) => {
        pi.on("tool_call", async (event) => {
          const decision = await this.gate.check(event.toolName, event.input);
          if (decision.allowed) return undefined;
          return { block: true, reason: decision.reason };
        });

        // Slash commands are only reachable through the extension API, and only
        // once the runtime is initialised — so capture the accessor and call it
        // lazily. It covers prompt templates, skills, and extension commands.
        this.getPiCommands = () =>
          pi.getCommands().map((command) => ({
            name: command.name,
            description: command.description,
            source: command.source,
          }));
      },
    };

    const voice = resolvedVoice(workspace.file);
    const toolHooks: PiconeToolHooks = {
      ...this.options.toolHooks,
      speak: (text) => this.options.emit(this.id, { type: "voice.speak", text }),
    };

    const customTools: ToolDefinition[] = [...createCommentTools(toolHooks), ...this.options.extraTools()];
    if (voice.output) customTools.push(createSpeakTool(toolHooks));

    const agentDir = getAgentDir();
    // Filter rather than uninstall: Pi's own config is left alone, so the CLI
    // still sees every skill, prompt and package the user installed. A name the
    // workspace says nothing about is on — see WorkspaceResources.
    const off = (resources: WorkspaceResources | undefined) => {
      const names = Object.entries(resources ?? {})
        .filter(([, entry]) => entry.enabled === false)
        .map(([name]) => name);
      return new Set(names);
    };
    /*
     * Read through `this.workspace`, not the `workspace` captured here: these
     * closures run again on every `reloadResources()`, and rebuilding from the
     * workspace as it was when the session started is the one thing a reload
     * exists to avoid.
     */
    const offExtensions = () => off(this.workspace.file.extensions);
    const offSkills = () => off(this.workspace.file.skills);
    const offPrompts = () => off(this.workspace.file.prompts);

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      // Pi finds global skills under ~/.pi/agent and ~/.agents itself; these are
      // the extra directories configured in the workspace and global settings.
      additionalSkillPaths: [
        ...resolveSkillPaths(this.workspace.file, this.workspace.path),
        ...this.options.globalSkillPaths,
      ],
      extensionFactories: [permissionExtension],
      extensionsOverride: (base) => {
        const errorsByPath = new Map(base.errors.map((e) => [e.path, e.error]));
        this.discovered.extensions = base.extensions
          .filter((e) => !isInternalExtension(e))
          .map((e) => ({
            name: extensionName(e),
            source: e.resolvedPath || e.path,
            error: errorsByPath.get(e.path),
          }));
        return {
          ...base,
          extensions: base.extensions.filter(
            (e) => isInternalExtension(e) || !offExtensions().has(extensionName(e)),
          ),
        };
      },
      skillsOverride: (base) => {
        this.discovered.skills = base.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          source: skill.filePath,
        }));
        return { ...base, skills: base.skills.filter((skill) => !offSkills().has(skill.name)) };
      },
      promptsOverride: (base) => {
        this.discovered.prompts = base.prompts.map((prompt) => ({
          name: prompt.name,
          description: prompt.description,
          source: prompt.filePath,
        }));
        return { ...base, prompts: base.prompts.filter((prompt) => !offPrompts().has(prompt.name)) };
      },
      // The workspace description is injected once, as a context file. Pi owns
      // it from there — we never re-inject it (DESIGN §6).
      agentsFilesOverride: (base) => ({
        agentsFiles: [
          ...base.agentsFiles,
          { path: `${this.workspace.path} (workspace)`, content: workspaceContext(this.workspace) },
          // Each memory directory explains itself, so what goes in is its own
          // AGENTS.md rather than a description we invented (§50).
          ...memoryContextFiles(this.workspace.memory),
        ],
      }),
    });
    await loader.reload();
    this.resourceLoader = loader;

    const modelRuntime = await ModelRuntime.create();
    this.modelRuntime = modelRuntime;
    const wanted = workspace.file.model;
    const model =
      wanted?.provider && wanted?.model ? modelRuntime.getModel(wanted.provider, wanted.model) : undefined;
    if (wanted?.provider && wanted?.model && !model) {
      this.translator.notice(
        `Model ${wanted.provider}/${wanted.model} from the workspace file is not available; using the default model.`,
        "warn",
      );
    }

    const sessionManager = this.options.sessionFile
      ? SessionManager.open(this.options.sessionFile)
      : SessionManager.create(cwd);

    const { session } = await createAgentSession({
      cwd,
      agentDir,
      model,
      thinkingLevel: wanted?.thinking as never,
      modelRuntime,
      resourceLoader: loader,
      customTools,
      sessionManager,
    });

    this.session = session;
    this.unsubscribe = session.subscribe((event) => this.translator.handle(event));
    // A restored session has a transcript and a branch but no ids linking them.
    this.syncEntryIds();
    this.publishContext();

    // Extension slash commands talk to the user through Pi's extension UI
    // context. `mode: "rpc"` is the honest label — like RPC mode, we serialise
    // that surface to a remote client instead of drawing a TUI. It also makes
    // `ctx.hasUI` true, which extensions branch on before offering dialogs.
    await session.bindExtensions({
      mode: "rpc",
      uiContext: this.extensionUi.context() as never,
      abortHandler: () => void session.abort(),
      onError: (error) => this.translator.notice(formatExtensionError(error), "error"),
    });

    if (session.sessionFile) this.options.onSessionFile(this.id, session.sessionFile);
    this.reconcileName();
  }

  // --- extension UI ----------------------------------------------------------

  /** Resolve a blocking extension dialog with the human's answer. */
  answerExtensionUi(answer: ExtensionUiAnswer): void {
    this.extensionUi.answer(answer);
  }

  keyExtensionUi(id: string, data: string): void {
    this.extensionUi.key(id, data);
  }

  /** Mirror of the browser composer, so `getEditorText()` returns something real. */
  setEditorText(text: string): void {
    this.editorText = text;
  }

  // --- inbound ---------------------------------------------------------------

  /**
   * `displayText` lets the transcript stay readable when the model-facing text
   * is a long structured block — a file comment, for instance.
   */
  async prompt(text: string, source: "chat" | "voice" | "comment" = "chat", displayText?: string): Promise<void> {
    if (!text.trim()) return;

    const shown = displayText ?? text;
    const item: ChatItem = { kind: "user", id: randomUUID(), text: shown, source, at: new Date().toISOString() };
    this.commit(item);
    this.options.emit(this.id, { type: "user.message", id: item.id, text: shown, source, at: item.at });

    const sent = this.withMentions(text);

    try {
      if (this.session.isStreaming) {
        await this.session.prompt(sent, { streamingBehavior: "steer" });
      } else {
        await this.session.prompt(sent);
      }
    } catch (err) {
      this.translator.notice(`Prompt failed: ${(err as Error).message}`, "error");
      this.translator.setState("idle");
    }

    this.syncEntryIds();
    this.publishContext();
  }

  /** Explicit steering — used by voice and comments during an active run. */
  async steer(text: string, source: "chat" | "voice" | "comment" = "chat", displayText?: string): Promise<void> {
    if (!this.session.isStreaming) {
      await this.prompt(text, source, displayText);
      return;
    }
    const shown = displayText ?? text;
    const item: ChatItem = { kind: "user", id: randomUUID(), text: shown, source, at: new Date().toISOString() };
    this.commit(item);
    this.options.emit(this.id, { type: "user.message", id: item.id, text: shown, source, at: item.at });
    try {
      await this.session.steer(this.withMentions(text));
    } catch (err) {
      this.translator.notice(`Steering failed: ${(err as Error).message}`, "error");
    }

    this.syncEntryIds();
  }

  /**
   * Append pointers for any `@subject` the message named (DESIGN §52).
   *
   * The transcript keeps what the user typed; only the model-facing copy grows,
   * and only by a path and an instruction to look wider. A message that mentions
   * nobody is returned untouched, which is almost every message.
   */
  /**
   * What the agent receives on top of what was typed (§51, §16).
   *
   * Two additions, both about things the message names rather than describes: a
   * pointer to any memory subject it mentions, and the open comments on any
   * file it names. Appended rather than woven in, and kept out of the
   * transcript, so what the reader sees is what they wrote.
   */
  private withMentions(text: string): string {
    const comments = commentContext(text, this.options.toolHooks.openComments());
    if (comments) text = `${text}

---

${comments}`;
    const pointers = mentionContext(text, memorySubjects(this.workspace.memory));
    return pointers ? `${text}

---

${pointers}` : text;
  }

  async abort(): Promise<void> {
    await this.session.abort();
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
   * If Pi is working it steers; otherwise it is just the next user message.
   */
  async injectComment(modelText: string, displayText: string): Promise<void> {
    if (this.session.isStreaming) await this.steer(modelText, "comment", displayText);
    else await this.prompt(modelText, "comment", displayText);
  }

  // --- context and compaction (DESIGN §54) -----------------------------------

  /**
   * Summarise the conversation so far and drop what the summary replaces.
   *
   * Pi does all of it — including aborting whatever is running first, which is
   * why this does not check `isStreaming`. Failures arrive as `compaction_end`
   * on the event stream rather than as a rejection, so the catch here is for
   * the call itself refusing, not for a summary that went wrong.
   */
  /**
   * Re-read everything a session was built with (DESIGN §34).
   *
   * Pi assembles the system prompt once — the workspace description, the
   * skills, the memory stores' instructions — and caches it, so an edit made
   * afterwards is invisible to a running session. `session.reload()` reloads
   * the resource loader, which re-runs our overrides against the workspace as
   * it now is, restarts the extensions, and rebuilds the prompt from the
   * result.
   */
  async reloadResources(): Promise<void> {
    await this.session.reload();
    this.translator.notice("Reloaded: skills, extensions and the workspace description are current again.", "info");
    this.publishContext();
  }

  /**
   * What the session has cost so far, from Pi's own tally (DESIGN §36).
   *
   * Pi aggregates over every entry in the session file, including history that
   * compaction has since dropped, so this is what was actually billed rather
   * than what the transcript still shows. It goes in as a notice: it is an
   * answer to a question the human asked, and no business of the agent's.
   */
  reportStats(): void {
    const stats = this.session.getSessionStats();
    const tokens = stats.tokens;
    const lines = [
      `${stats.userMessages} sent · ${stats.assistantMessages} replies · ${stats.toolCalls} tool calls`,
      `Tokens: ${tokens.total.toLocaleString()} (${tokens.input.toLocaleString()} in, ${tokens.output.toLocaleString()} out, ${tokens.cacheRead.toLocaleString()} cached)`,
      `Cost: $${stats.cost.toFixed(4)}`,
    ];
    this.translator.notice(lines.join("\n"), "info");
  }

  /**
   * Write the session out as HTML, through Pi's own exporter.
   *
   * Pi decides the format and the location — its session directory — because it
   * owns the session file this is rendered from, and a second renderer here
   * would drift from it. We only say where it landed.
   */
  async exportHtml(): Promise<void> {
    try {
      const path = await this.session.exportToHtml();
      this.translator.notice(`Exported to ${path}`, "info");
    } catch (err) {
      this.translator.notice(`Could not export: ${(err as Error).message}`, "error");
    }
  }

  async compact(): Promise<void> {
    try {
      await this.session.compact();
    } catch (err) {
      this.translator.notice(`Could not compact: ${(err as Error).message}`, "error");
    }
    this.publishContext();
  }

  /** Whether Pi compacts on its own when the context fills (DESIGN §54). */
  get autoCompaction(): boolean {
    return this.session.autoCompactionEnabled;
  }

  /**
   * Turn Pi's automatic compaction on or off.
   *
   * This writes Pi's own settings, which are global to Pi rather than scoped to
   * a session or a workspace — the CLI sees the same flag. Picone reads it back
   * rather than keeping a copy, the same way it treats the session name (§26).
   */
  setAutoCompaction(enabled: boolean): void {
    this.session.setAutoCompactionEnabled(enabled);
  }

  /**
   * Say how full the context is, whenever it can have changed.
   *
   * Pi offers this as a reading rather than an event, so it is sampled at the
   * moments that move it: a turn ending, a compaction ending, and a session
   * being opened. `tokens` is null until a reply has come back, which is a real
   * state — right after compaction — and not an error.
   *
   * It is also sampled whenever a transcript is pushed, which is what makes it
   * survive a reload. Those three moments are all *changes*, and a browser that
   * reconnects to an already-open session sees none of them: the reading was
   * emitted while it was away and the dial stayed empty until the next reply.
   * Being a pull rather than an event, it costs nothing to ask again.
   */
  publishContext(): void {
    const usage = this.session.getContextUsage();
    this.options.emit(this.id, { type: "context.usage", usage: usage ?? null });
  }

  // --- the session name (DESIGN §26) -----------------------------------------

  /**
   * Pi has a session name and never invents one — `setSessionName` is all it
   * offers, and its own interface falls back to showing your first message.
   * Picone keeps its own title, so the two have to be kept in step or a `/name`
   * from the CLI is invisible here and a rename here never reaches the file.
   *
   * The file wins when it has an opinion. It is the shared artifact: Pi can be
   * pointed at the same session from a terminal between runs, and whatever it
   * was called there is what the session is called. When the file has no name
   * and we have a real one, ours goes in, so the two converge either way.
   */
  private reconcileName(): void {
    const piName = this.session.sessionManager.getSessionName();
    if (piName) {
      if (piName !== this.title) this.applyTitle(piName);
      return;
    }
    if (this.title && this.title !== DEFAULT_TITLE) this.session.setSessionName(this.title);
  }

  /** Pi's name changed — from `/name`, an extension, or our own rename. */
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
   * Rename from Picone. Pi sanitizes — newlines become spaces and it is
   * trimmed — so the stored title comes back from Pi rather than from the
   * caller, and the two cannot drift apart on a technicality.
   */
  rename(title: string): string {
    this.session.setSessionName(title);
    return this.session.sessionManager.getSessionName() || DEFAULT_TITLE;
  }

  // --- the session tree (DESIGN §53) -----------------------------------------

  /**
   * Tag each user message with the Pi entry it became (DESIGN §53).
   *
   * Pi does not announce this: `entry_appended` fires only for entries an
   * *extension* appended, never for ordinary messages. What it does offer is
   * the branch — the root-to-leaf path — and the user messages on it are the
   * same sequence, in the same order, as the user items in our transcript.
   *
   * Aligned from the start and checked as it goes: the entry holds the
   * model-facing text, which for a mention (§52) has a pointer block appended,
   * so the test is that the entry *starts with* what we displayed. The moment
   * the two disagree it stops. A missing id costs a rewind affordance on that
   * message, which is the right way to be wrong.
   */
  private syncEntryIds(): void {
    const entries = this.session.sessionManager
      .getBranch()
      .filter((e): e is typeof e & { message: { role: string; content: unknown } } =>
        e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user",
      );

    const items = this.transcript.filter((i) => i.kind === "user");
    let changed = false;

    /*
     * Walked from the end backwards, which matters now that the transcript in
     * memory is only the tail (§14): the two sequences share a *suffix*, not a
     * prefix, so pairing them from the start would line the oldest entry up
     * against a message from the middle of the conversation.
     */
    for (let offset = 1; offset <= Math.min(entries.length, items.length); offset++) {
      const entry = entries[entries.length - offset];
      const item = items[items.length - offset];
      if (!entry || !item || item.kind !== "user") break;
      if (item.entryId === entry.id) continue;
      if (!entryStartsWith(entry.message.content, item.text)) break;

      item.entryId = entry.id;
      appendMessage(this.id, this.seqOf(item), item);
      changed = true;
    }

    if (changed) this.options.emit(this.id, this.snapshot());
  }

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
   * Move the leaf back to just before a message, in the same session file.
   *
   * Pi does the real work: `navigateTree` on a user message sets the leaf to
   * that message's *parent*, hands back its text, and rebuilds the agent's
   * in-memory messages from the new branch. Nothing is deleted — the abandoned
   * path is still in the file, reachable by its own leaf.
   *
   * Our transcript is not Pi's (§37), so it is truncated to match: everything
   * from the rewound message onwards belongs to the branch just left.
   */
  async rewind(itemId: string): Promise<void> {
    if (this.session.isStreaming) throw new Error("Stop the agent before rewinding.");
    const { entryId, index } = this.entryFor(itemId);

    const dropped = this.transcript.length - index;
    const result = await this.session.navigateTree(entryId);
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

  /**
   * The same point, in a session of its own.
   *
   * `createBranchedSession` writes the path up to an entry into a new file —
   * but it also *switches the manager it is called on* to that file, which
   * would hijack this session. So it runs on a throwaway manager opened on the
   * same path, and only the returned filename is kept.
   */
  forkPoint(itemId: string): { sessionFile: string | null; text: string; history: ChatItem[] } {
    const { entryId, index } = this.entryFor(itemId);
    const item = this.transcript[index];
    const text = item?.kind === "user" ? item.text : "";
    // Pi carries the history in the branched file; this is the same history for
    // the browser, which keeps its own transcript (§37). Entry ids survive the
    // branch — Pi re-chains parents but keeps every id — so the forked messages
    // stay rewindable too.
    const history = this.transcript.slice(0, index).map((entry) => structuredClone(entry));

    const entry = this.session.sessionManager.getEntry(entryId);
    // Fork *before* the message, so the new session opens with it in the
    // composer rather than already having asked it.
    const upTo = entry?.parentId;
    // No file yet means Pi has not persisted this session — it has had no
    // assistant reply — so there is no history to carry across either.
    const source = this.session.sessionManager.getSessionFile();
    if (!upTo || !source) return { sessionFile: null, text, history };

    const scratch = SessionManager.open(source);
    const file = scratch.createBranchedSession(upTo);
    // Pi defers writing a branch that holds no assistant reply, so the path it
    // returns may not exist yet. A fork from the very first message is just a
    // new session, which is what a missing file becomes.
    return { sessionFile: file && existsSync(file) ? file : null, text, history };
  }

  /**
   * The workspace file changed. Permissions and the writable roots both come
   * from it, so they are refreshed together rather than drifting apart.
   */
  updateWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
    this.gate.updatePermissions(resolvedPermissions(workspace.file));
  }

  /**
   * Swap the model on the live session (DESIGN §41: Pi owns the agent loop, we
   * only drive it). Takes effect on the next turn, mid-conversation.
   */
  async setModel(provider: string, model: string, thinking?: string): Promise<void> {
    const resolved = this.modelRuntime.getModel(provider, model);
    if (!resolved) throw new Error(`Model ${provider}/${model} is not available`);
    await this.session.setModel(resolved);
    if (thinking) this.session.setThinkingLevel(thinking as never);
    this.translator.notice(`Model switched to ${provider}/${model}.`, "info");
  }

  currentModel(): SessionModel | undefined {
    const model = this.session?.model;
    if (!model) return undefined;
    return { provider: model.provider, model: model.id, thinking: this.session.thinkingLevel };
  }

  /** Slash commands Pi knows about in this session. */
  commands(): SlashCommand[] {
    return this.getPiCommands?.() ?? [];
  }

  /** What Pi discovered for this session — the only way to see it from the browser. */
  resources(): ResourceReport | null {
    if (!this.resourceLoader) return null;
    const byName = (a: ResourceInfo, b: ResourceInfo) => a.name.localeCompare(b.name);
    return {
      extensions: [...this.discovered.extensions].sort(byName),
      skills: [...this.discovered.skills].sort(byName),
      prompts: [...this.discovered.prompts].sort(byName),
    };
  }

  // --- outbound --------------------------------------------------------------

  get state(): AgentState {
    return this.translator.getState();
  }

  get isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }

  get sessionFile(): string | undefined {
    return this.session?.sessionFile;
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
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      sessionFile: this.sessionFile,
      model: this.currentModel(),
      forkedFrom: this.forkedFrom,
    };
  }

  notice(text: string, level: "info" | "warn" | "error" = "info"): void {
    this.translator.notice(text, level);
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const [, entry] of this.pending) entry.resolve("deny");
    this.pending.clear();
    this.extensionUi.dispose();
    this.session?.dispose();
  }

  /**
   * Give a freshly forked session the conversation it inherited (DESIGN §53).
   * Pi already has it, in the branched session file; this is the browser's copy.
   */
  seedTranscript(items: ChatItem[]): void {
    this.transcript = items;
    this.baseSeq = 0;
    this.seq = items.length;
    items.forEach((item, index) => appendMessage(this.id, index, item));
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

/**
 * Whether a session entry's content begins with the text we showed.
 *
 * Pi stores message content as a string or as content parts; both shapes turn
 * up depending on how the message was built.
 */
function entryStartsWith(content: unknown, shown: string): boolean {
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((part) => (typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : ""))
            .join("")
        : "";
  return text.trimStart().startsWith(shown.trimStart());
}
