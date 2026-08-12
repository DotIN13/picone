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
  AgentCapabilities,
  ContextUsage,
  ResourceInfo,
  ResourceReport,
  SessionModel,
  SlashCommand,
  Workspace,
  WorkspaceResources,
} from "@picone/protocol";
import type { AgentBackend, AgentBackendContext, AgentHost } from "../agents/backend.ts";
import { memoryContextFiles } from "../memory/context.ts";
import { resolvedVoice } from "../workspace/schema.ts";
import { resolveSkillPaths, workspaceContext } from "../workspace/loader.ts";
import { handlePiEvent } from "./events.ts";
import { ExtensionUiBridge } from "./extension-ui.ts";
import { createCommentTools, createSpeakTool, type PiconeToolHooks } from "./tools.ts";

/**
 * Pi behind one Picone session (DESIGN §8).
 *
 * Everything Pi owns — history, context, compaction, tool execution — stays
 * inside `AgentSession`. This supplies the environment around it and translates
 * both directions. What is *not* here, and used to be, is the transcript, the
 * permission gate and the title: those belong to every agent equally and now
 * live in the shell (`agents/session.ts`).
 */

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

/** Everything Pi can do, which is currently everything Picone asks for. */
const PI_CAPABILITIES: AgentCapabilities = {
  rewind: true,
  fork: true,
  compact: true,
  autoCompaction: true,
  reload: true,
  exportHtml: true,
  extensionUi: true,
  // Pi rewinds the conversation and leaves the disk where it is (§53).
  fileCheckpoints: false,
  // Pi has one way of working, so there is no switch to draw (§58).
  modes: [],
};

export class PiBackend implements AgentBackend {
  readonly kind = "pi" as const;
  readonly capabilities = PI_CAPABILITIES;

  private session!: AgentSession;
  private unsubscribe: (() => void) | null = null;
  private modelRuntime!: ModelRuntime;
  /** Captured from the extension context; the only accessor for slash commands. */
  private getPiCommands: (() => SlashCommand[]) | null = null;
  private resourceLoader: DefaultResourceLoader | null = null;
  private readonly bridge: ExtensionUiBridge;
  private workspace: Workspace;
  /**
   * Everything Pi found, captured before the workspace's switches are applied —
   * the loader only keeps what survived, and the settings panel has to show
   * what was switched off in order to switch it back on.
   */
  private discovered: ResourceReport = { extensions: [], skills: [], prompts: [] };

  private constructor(private readonly context: AgentBackendContext) {
    this.workspace = context.workspace;
    const host = context.host;
    this.bridge = new ExtensionUiBridge({
      prompt: (prompt) => host.emit({ type: "extension.ui.prompt", prompt }),
      closePrompt: (id) => host.emit({ type: "extension.ui.prompt.closed", id }),
      update: (update) => host.emit({ type: "extension.ui.update", update }),
      frame: (id, lines) => host.emit({ type: "extension.ui.frame", id, lines }),
      notify: (message, level) => host.translator.notice(message, level),
      editorText: () => host.editorText(),
    });
  }

  static async create(context: AgentBackendContext): Promise<PiBackend> {
    const backend = new PiBackend(context);
    await backend.init();
    return backend;
  }

  private get host(): AgentHost {
    return this.context.host;
  }

  private async init(): Promise<void> {
    const { cwd, host } = this.context;
    const workspace = this.workspace;

    const permissionExtension: InlineExtension = {
      name: "picone-permissions",
      factory: (pi) => {
        pi.on("tool_call", async (event) => {
          const decision = await host.askPermission(event.toolName, event.input);
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
      speak: (text) => host.speak(text),
      resolveComment: (commentId) => host.resolveComment(commentId),
      openComments: () => host.openComments(),
    };

    const customTools: ToolDefinition[] = [
      ...createCommentTools(toolHooks),
      ...this.context.services.piTools(),
    ];
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
     * closures run again on every `reload()`, and rebuilding from the workspace
     * as it was when the session started is the one thing a reload exists to
     * avoid.
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
        ...this.context.services.globalSkillPaths(),
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
    const wanted = workspace.file.models?.pi ?? workspace.file.model;
    const model =
      wanted?.provider && wanted?.model ? modelRuntime.getModel(wanted.provider, wanted.model) : undefined;
    if (wanted?.provider && wanted?.model && !model) {
      host.translator.notice(
        `Model ${wanted.provider}/${wanted.model} from the workspace file is not available; using the default model.`,
        "warn",
      );
    }

    const sessionManager = this.context.resumeRef
      ? SessionManager.open(this.context.resumeRef)
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
    this.unsubscribe = session.subscribe((event) => handlePiEvent(host.translator, event));

    // Extension slash commands talk to the user through Pi's extension UI
    // context. `mode: "rpc"` is the honest label — like RPC mode, we serialise
    // that surface to a remote client instead of drawing a TUI. It also makes
    // `ctx.hasUI` true, which extensions branch on before offering dialogs.
    await session.bindExtensions({
      mode: "rpc",
      uiContext: this.bridge.context() as never,
      abortHandler: () => void session.abort(),
      onError: (error) => host.translator.notice(formatExtensionError(error), "error"),
    });
  }

  // --- the conversation --------------------------------------------------------

  async prompt(text: string): Promise<void> {
    if (this.session.isStreaming) await this.session.prompt(text, { streamingBehavior: "steer" });
    else await this.session.prompt(text);
  }

  async steer(text: string): Promise<void> {
    await this.session.steer(text);
  }

  async abort(): Promise<void> {
    await this.session.abort();
  }

  get isStreaming(): boolean {
    return this.session?.isStreaming ?? false;
  }

  // --- the model ----------------------------------------------------------------

  model(): SessionModel | undefined {
    const model = this.session?.model;
    if (!model) return undefined;
    return { provider: model.provider, model: model.id, thinking: this.session.thinkingLevel };
  }

  async setModel(provider: string, model: string, thinking?: string): Promise<void> {
    const resolved = this.modelRuntime.getModel(provider, model);
    if (!resolved) throw new Error(`Model ${provider}/${model} is not available`);
    await this.session.setModel(resolved);
    if (thinking) this.session.setThinkingLevel(thinking as never);
  }

  /**
   * Pi offers this as a reading rather than an event, so it is sampled at the
   * moments that move it. `tokens` is null until a reply has come back, which
   * is a real state — right after compaction — and not an error.
   */
  async contextUsage(): Promise<ContextUsage | null> {
    return this.session.getContextUsage() ?? null;
  }

  commands(): SlashCommand[] {
    return this.getPiCommands?.() ?? [];
  }

  resources(): ResourceReport | null {
    if (!this.resourceLoader) return null;
    const byName = (a: ResourceInfo, b: ResourceInfo) => a.name.localeCompare(b.name);
    return {
      extensions: [...this.discovered.extensions].sort(byName),
      skills: [...this.discovered.skills].sort(byName),
      prompts: [...this.discovered.prompts].sort(byName),
    };
  }

  /**
   * Pi aggregates over every entry in the session file, including history that
   * compaction has since dropped, so this is what was actually billed rather
   * than what the transcript still shows (§36).
   */
  async statsLines(): Promise<string[]> {
    const stats = this.session.getSessionStats();
    const tokens = stats.tokens;
    return [
      `${stats.userMessages} sent · ${stats.assistantMessages} replies · ${stats.toolCalls} tool calls`,
      `Tokens: ${tokens.total.toLocaleString()} (${tokens.input.toLocaleString()} in, ${tokens.output.toLocaleString()} out, ${tokens.cacheRead.toLocaleString()} cached)`,
      `Cost: $${stats.cost.toFixed(4)}`,
    ];
  }

  // --- session-level operations --------------------------------------------------

  async compact(): Promise<void> {
    await this.session.compact();
  }

  /**
   * Pi assembles the system prompt once and caches it, so an edit made
   * afterwards is invisible to a running session. `session.reload()` reloads
   * the resource loader, which re-runs our overrides against the workspace as
   * it now is, restarts the extensions, and rebuilds the prompt (§34).
   */
  async reload(): Promise<void> {
    await this.session.reload();
  }

  /**
   * Pi decides the format and the location — its session directory — because it
   * owns the session file this is rendered from, and a second renderer here
   * would drift from it.
   */
  async exportHtml(): Promise<string> {
    return this.session.exportToHtml();
  }

  autoCompaction = {
    get: () => this.session.autoCompactionEnabled,
    /**
     * Pi's own settings, global to Pi rather than scoped to a session or a
     * workspace — the CLI sees the same flag. Picone reads it back rather than
     * keeping a copy, the same way it treats the session name (§26).
     */
    set: (enabled: boolean) => this.session.setAutoCompactionEnabled(enabled),
  };

  extensionUi = {
    answer: (answer: Parameters<ExtensionUiBridge["answer"]>[0]) => this.bridge.answer(answer),
    key: (id: string, data: string) => this.bridge.key(id, data),
  };

  agentName(): string | undefined {
    return this.session.sessionManager.getSessionName() || undefined;
  }

  rename(title: string): string {
    this.session.setSessionName(title);
    return this.session.sessionManager.getSessionName() || title;
  }

  // --- the session tree (DESIGN §53) ----------------------------------------------

  /**
   * Tag each user message with the Pi entry it became.
   *
   * Pi does not announce this: `entry_appended` fires only for entries an
   * *extension* appended, never for ordinary messages. What it does offer is
   * the branch — the root-to-leaf path — and the user messages on it are the
   * same sequence, in the same order, as the user items in the transcript.
   *
   * Aligned from the end and checked as it goes: the entry holds the
   * model-facing text, which for a mention (§52) has a pointer block appended,
   * so the test is that the entry *starts with* what we displayed. The moment
   * the two disagree it stops. A missing id costs a rewind affordance on that
   * message, which is the right way to be wrong.
   */
  syncEntryIds(): void {
    const entries = this.session.sessionManager
      .getBranch()
      .filter((e): e is typeof e & { message: { role: string; content: unknown } } =>
        e.type === "message" && (e as { message?: { role?: string } }).message?.role === "user",
      );

    const items = this.host.userMessages();

    /*
     * Walked from the end backwards, which matters now that the transcript in
     * memory is only the tail (§14): the two sequences share a *suffix*, not a
     * prefix, so pairing them from the start would line the oldest entry up
     * against a message from the middle of the conversation.
     */
    for (let offset = 1; offset <= Math.min(entries.length, items.length); offset++) {
      const entry = entries[entries.length - offset];
      const item = items[items.length - offset];
      if (!entry || !item) break;
      if (item.entryId === entry.id) continue;
      if (!entryStartsWith(entry.message.content, item.text)) break;
      this.host.tagEntry(item.id, entry.id);
    }
  }

  /**
   * `navigateTree` on a user message sets the leaf to that message's *parent*,
   * hands back its text, and rebuilds the agent's in-memory messages from the
   * new branch. Nothing is deleted — the abandoned path is still in the file,
   * reachable by its own leaf.
   */
  async rewindTo(entryId: string): Promise<{ cancelled: boolean; editorText?: string }> {
    const result = await this.session.navigateTree(entryId);
    return { cancelled: Boolean(result.cancelled), editorText: result.editorText };
  }

  /**
   * `createBranchedSession` writes the path up to an entry into a new file —
   * but it also *switches the manager it is called on* to that file, which
   * would hijack this session. So it runs on a throwaway manager opened on the
   * same path, and only the returned filename is kept.
   */
  forkFrom(entryId: string): { resumeRef: string | null } {
    const entry = this.session.sessionManager.getEntry(entryId);
    // Fork *before* the message, so the new session opens with it in the
    // composer rather than already having asked it.
    const upTo = entry?.parentId;
    // No file yet means Pi has not persisted this session — it has had no
    // assistant reply — so there is no history to carry across either.
    const source = this.session.sessionManager.getSessionFile();
    if (!upTo || !source) return { resumeRef: null };

    const scratch = SessionManager.open(source);
    const file = scratch.createBranchedSession(upTo);
    // Pi defers writing a branch that holds no assistant reply, so the path it
    // returns may not exist yet. A fork from the very first message is just a
    // new session, which is what a missing file becomes.
    return { resumeRef: file && existsSync(file) ? file : null };
  }

  updateWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  resumeRef(): string | undefined {
    return this.session?.sessionFile;
  }

  dispose(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.bridge.dispose();
    this.session?.dispose();
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
            .map((part) =>
              typeof part === "object" && part && "text" in part ? String((part as { text: unknown }).text) : "",
            )
            .join("")
        : "";
  return text.trimStart().startsWith(shown.trimStart());
}
