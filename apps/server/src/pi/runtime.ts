import { randomUUID } from "node:crypto";
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
import { appendMessage, loadTranscript } from "../db.ts";
import { memoryContextFiles } from "../memory/context.ts";
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

  private transcript: ChatItem[] = [];
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
    const cwd = workspace.roots.find((r) => r.exists && r.kind === "directory")?.path ?? process.cwd();

    this.transcript = loadTranscript(this.id);
    this.seq = this.transcript.length;

    this.translator = new EventTranslator({
      emit: (event) => this.options.emit(this.id, event),
      commit: (item) => this.commit(item),
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
    const offExtensions = off(workspace.file.extensions);
    const offSkills = off(workspace.file.skills);
    const offPrompts = off(workspace.file.prompts);

    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      // Pi finds global skills under ~/.pi/agent and ~/.agents itself; these are
      // the extra directories configured in the workspace and global settings.
      additionalSkillPaths: [
        ...resolveSkillPaths(workspace.file, workspace.path),
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
            (e) => isInternalExtension(e) || !offExtensions.has(extensionName(e)),
          ),
        };
      },
      skillsOverride: (base) => {
        this.discovered.skills = base.skills.map((skill) => ({
          name: skill.name,
          description: skill.description,
          source: skill.filePath,
        }));
        return { ...base, skills: base.skills.filter((skill) => !offSkills.has(skill.name)) };
      },
      promptsOverride: (base) => {
        this.discovered.prompts = base.prompts.map((prompt) => ({
          name: prompt.name,
          description: prompt.description,
          source: prompt.filePath,
        }));
        return { ...base, prompts: base.prompts.filter((prompt) => !offPrompts.has(prompt.name)) };
      },
      // The workspace description is injected once, as a context file. Pi owns
      // it from there — we never re-inject it (DESIGN §6).
      agentsFilesOverride: (base) => ({
        agentsFiles: [
          ...base.agentsFiles,
          { path: `${workspace.path} (workspace)`, content: workspaceContext(workspace) },
          // Each memory directory explains itself, so what goes in is its own
          // AGENTS.md rather than a description we invented (§50).
          ...memoryContextFiles(workspace.memory),
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
  }

  // --- extension UI ----------------------------------------------------------

  /** Resolve a blocking extension dialog with the human's answer. */
  answerExtensionUi(answer: ExtensionUiAnswer): void {
    this.extensionUi.answer(answer);
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
  }

  /**
   * Append pointers for any `@subject` the message named (DESIGN §52).
   *
   * The transcript keeps what the user typed; only the model-facing copy grows,
   * and only by a path and an instruction to look wider. A message that mentions
   * nobody is returned untouched, which is almost every message.
   */
  private withMentions(text: string): string {
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
      appendMessage(this.id, this.transcript.indexOf(item), item);
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

  /** Push a short workspace-change note into the conversation (DESIGN §34). */
  async notifyWorkspaceChange(text: string): Promise<void> {
    // Shown as a notice rather than a user message: the human changed a setting,
    // they did not say this to the agent.
    this.translator.notice(text, "info");
    if (this.session.isStreaming) {
      await this.session.followUp(text);
    } else {
      await this.session.prompt(text);
    }
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
    return { type: "session.snapshot", sessionId: this.id, items: this.transcript, state: this.state };
  }

  summary(): SessionSummary {
    return {
      id: this.id,
      title: this.title,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      sessionFile: this.sessionFile,
      model: this.currentModel(),
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
  }
}
