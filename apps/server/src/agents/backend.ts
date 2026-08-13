import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type {
  AgentAsk,
  AgentCapabilities,
  AgentMode,
  AgentEvent,
  AgentKind,
  ContextUsage,
  ExtensionUiAnswer,
  FileComment,
  ModelOption,
  ResourceReport,
  SessionModel,
  SlashCommand,
  Workspace,
  WorkspaceMcpConfig,
} from "@picone/protocol";
import type { EventTranslator } from "./translator.ts";

/**
 * What Picone needs from an agent, and nothing more (DESIGN §8).
 *
 * The shell around this — `agents/session.ts` — owns the transcript, the
 * database rows, the permission gate, mentions, comments and the title, none of
 * which are any agent's business. What is left here is the conversation itself
 * and the handful of operations that only the agent can perform.
 *
 * Everything optional is guarded by `capabilities`, which the browser reads:
 * an affordance for something a session cannot do should not be drawn, rather
 * than drawn and then apologised for.
 */
export interface AgentBackend {
  readonly kind: AgentKind;
  readonly capabilities: AgentCapabilities;

  /** Say something. The shell has already put it in the transcript. */
  prompt(text: string): Promise<void>;
  /** Say something *into* a run that is already going. */
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  readonly isStreaming: boolean;

  model(): SessionModel | undefined;
  setModel(provider: string, model: string, thinking?: string): Promise<void>;
  /** How full the context is (§54); null when the agent cannot say yet. */
  contextUsage(): Promise<ContextUsage | null>;
  commands(): SlashCommand[];
  /**
   * The models this agent offers, when only a live session can say. Pi has a
   * catalogue that can be read without one, so it does not implement this.
   */
  modelOptions?(): ModelOption[];
  /** What the agent discovered for this session (§34), or null if it cannot say. */
  resources(): ResourceReport | null;
  /** Lines for the `/stats` notice (§36). */
  statsLines(): Promise<string[]>;

  /**
   * Directories that belong to the *agent* rather than to the workspace, and
   * which it may therefore write (§9).
   *
   * The gate exists to keep an agent inside the user's project, not to stop it
   * keeping its own notes: Claude Code writes its session transcripts and its
   * plan files under `~/.claude`, so refusing them makes plan mode a mode that
   * cannot record a plan. Narrow on purpose — one directory, named by the
   * backend, and it appears in the refusal message like any other root.
   */
  agentRoots?(): string[];

  /** The workspace file changed under a live session (§34). */
  updateWorkspace(workspace: Workspace): void;
  /**
   * What to persist so this session can be reopened: Pi's session file, or
   * Claude's session id. Undefined until the agent has something to resume.
   */
  resumeRef(): string | undefined;
  dispose(): void;

  // --- guarded by `capabilities` ---------------------------------------------

  compact?(): Promise<void>;
  reload?(): Promise<void>;
  exportHtml?(): Promise<string>;
  /** Move the leaf back to just before an entry (§53). */
  rewindTo?(entryRef: string): Promise<{ cancelled: boolean; editorText?: string }>;
  /**
   * The same point in a session of its own (§53), as something the new session
   * can be opened with. Asynchronous because it may mean copying a transcript.
   */
  forkFrom?(entryRef: string): Promise<{ resumeRef: string | null }> | { resumeRef: string | null };
  /** The agent's own name for this session (§26), when it keeps one. */
  agentName?(): string | undefined;
  /** Push a name into the agent's own record of the session (§26). */
  rename?(title: string): string;
  /** How the agent is currently allowed to act, when it has more than one way. */
  mode?(): AgentMode;
  setMode?(mode: AgentMode): Promise<void>;
  /** Pi's automatic compaction switch (§54), which is Pi's own setting. */
  autoCompaction?: { get(): boolean; set(enabled: boolean): void };
  /** The extension UI surface (§55) — Pi only. */
  extensionUi?: { answer(answer: ExtensionUiAnswer): void; key(id: string, data: string): void };
  /**
   * Tag transcript items with the agent-side entry they became, so §53 has
   * something to address (through `host.tagEntry`). Pi has to infer the
   * mapping; Claude is told it outright.
   */
  syncEntryIds?(): void | Promise<void>;
}

/**
 * What a backend may call back into. Everything here is the shell's, and every
 * one of these calls already existed inside the Pi runtime before the split.
 */
export interface AgentHost {
  readonly sessionId: string;
  /**
   * The transcript assembler (§30). Shared rather than per-backend, because
   * the ordering rules it holds are not agent-specific.
   */
  readonly translator: EventTranslator;
  emit(event: AgentEvent): void;
  /**
   * The permission gate (§9/§10). Resolves when the human answers, which may
   * be a while — the caller must be willing to wait.
   */
  askPermission(toolName: string, input: unknown): Promise<{ allowed: boolean; reason?: string }>;
  /**
   * Ask the human something and wait for the answer (§59).
   *
   * Resolves with the labels chosen, or an empty list if it was dismissed —
   * which the caller must handle, because a human walking away is not an
   * answer and pretending otherwise is how an agent ends up acting on a
   * decision nobody made.
   */
  ask(ask: Omit<AgentAsk, "id" | "createdAt">): Promise<string[]>;
  /** The composer's contents, for an agent that can read or patch the editor. */
  editorText(): string;
  openComments(): FileComment[];
  resolveComment(id: string): FileComment | null;
  speak(text: string): void;
  /** The user messages in the transcript, oldest first (§53). */
  userMessages(): Array<{ id: string; text: string; entryId?: string }>;
  /** Record which agent-side entry a message became (§53). */
  tagEntry(itemId: string, entryId: string): void;
}

/** Everything a backend is built with. */
export interface AgentBackendContext {
  /** The session id, which some agents will also use as their own. */
  id: string;
  workspace: Workspace;
  /** Where work happens, already resolved from the workspace (§3). */
  cwd: string;
  /** A session file or id from a previous run of this session. */
  resumeRef?: string;
  host: AgentHost;
  services: AgentServices;
}

/** App-level things a backend may want, without reaching for the App itself. */
export interface AgentServices {
  /** Skill directories from global settings, on top of the workspace's own. */
  globalSkillPaths(): string[];
  /**
   * MCP tools Picone has already connected (§35), as Pi tool definitions —
   * for a backend that takes tools directly.
   */
  piTools(): ToolDefinition[];
  /**
   * The same servers as configuration, for a backend that would rather spawn
   * its own. Two connections to one server is the cost; see the Claude notes.
   */
  mcpConfigs(): Record<string, WorkspaceMcpConfig>;
}

/** Nothing supported. A starting point for a backend to override. */
export const NO_CAPABILITIES: AgentCapabilities = {
  rewind: false,
  fork: false,
  compact: false,
  autoCompaction: false,
  reload: false,
  exportHtml: false,
  extensionUi: false,
  fileCheckpoints: false,
  modes: [],
};
