/**
 * Picone wire protocol.
 *
 * This package is intentionally **type-only**: it contains no runtime values, so
 * both the server (tsc) and the web app (vite) can import it without a build step
 * and every import is erased at compile time.
 *
 * Pi's own event schema never crosses this boundary — the server translates it
 * into the `AgentEvent` union below (DESIGN §30).
 */

// ---------------------------------------------------------------------------
// Workspace file (DESIGN §4)
// ---------------------------------------------------------------------------

export type PermissionSetting = "allow" | "ask" | "deny";

export type PermissionCategory = "files" | "shell" | "git";

export interface WorkspaceSkill {
  name: string;
  path: string;
}

export interface WorkspaceMcpConfig {
  /** Command to spawn for a stdio MCP server. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** URL for a streamable-HTTP MCP server. */
  url?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
}

export interface WorkspacePermissions {
  files?: PermissionSetting;
  shell?: PermissionSetting;
  git?: PermissionSetting;
}

export interface WorkspaceModel {
  provider?: string;
  model?: string;
  /** off | minimal | low | medium | high | xhigh | max */
  thinking?: string;
}

export interface WorkspaceVoice {
  input?: boolean;
  output?: boolean;
}

/**
 * How this workspace configures one discovered skill, prompt template, or
 * extension. An object rather than a bare name, so the entry has somewhere to
 * grow — the same shape `mcp` uses.
 */
export interface WorkspaceResource {
  enabled?: boolean;
}

/**
 * Resources keyed by the name Pi knows them under.
 *
 * A name that is absent is enabled: Pi finds skills, prompts, and extensions on
 * its own, and something installed tomorrow should be available to today's
 * workspace without editing this file first.
 */
export type WorkspaceResources = Record<string, WorkspaceResource>;

/**
 * A folder of long-lived notes about the user, offered to the agent as reading
 * rather than as project code.
 *
 * An entry with no `path` is a workspace switching off one it inherited: the
 * two are merged field by field, so toggling a global directory never has to
 * restate where it lives.
 */
/**
 * A context directory with more said about it than its path.
 *
 * `hidden` opens the directory without drawing it: readable, mentionable and
 * resolvable like any other, but absent from the file explorer and from what
 * the agent is told. Home is opened this way — `~/.pi`, `~/.agents` and
 * `~/Downloads` are worth reaching, and nobody wants the whole of home as a row
 * above their code.
 */
export interface WorkspaceDir {
  path: string;
  hidden?: boolean;
}

/** A context directory: a path, or a path with something said about it. */
export type WorkspaceDirRef = string | WorkspaceDir;

/** The object form of an entry, whichever form it was written in. */
export function asWorkspaceDir(entry: WorkspaceDirRef): WorkspaceDir {
  return typeof entry === "string" ? { path: entry } : entry;
}

export interface MemoryDir {
  /** Absolute, `~`-relative, or relative to the file that declares it. */
  path?: string;
  enabled?: boolean;
  /** Default false, and enforced by the permission gate rather than merely stated. */
  writable?: boolean;
  /** Open, but left out of the file explorer — as on any directory (§3). */
  hidden?: boolean;
}

export type MemoryDirs = Record<string, MemoryDir>;

/** A merged, resolved entry — what the UI and the session runtime both read. */
export interface ResolvedMemoryDir {
  name: string;
  /** Absolute. */
  path: string;
  enabled: boolean;
  writable: boolean;
  exists: boolean;
  /** Where the path came from; a workspace entry that only toggles stays "global". */
  source: "global" | "workspace";
  /** Open, but left out of the file explorer (§3). */
  hidden: boolean;
  /** It carries an `AGENTS.md`, so it can explain itself to the agent. */
  hasInstructions: boolean;
  /** It carries an `index.md` worth pointing the agent at. */
  hasIndex: boolean;
  /** Top-level entries, for the settings list. */
  entries: number;
}

/**
 * Something in a memory directory that can be named with `@` (DESIGN §52).
 *
 * Everything but `path` exists for the autocomplete menu. `path` is the only
 * field the agent ever sees: a mention hands over a pointer, not a page.
 */
export interface MemorySubject {
  /** From the filename, and what the user types after `@`. */
  slug: string;
  /** From the page's first heading, falling back to the slug. */
  name: string;
  /** Whatever the page declares in its frontmatter; "" when it declares none. */
  type: string;
  /** First paragraph, one line, for the menu. */
  summary: string;
  /** Absolute path to the page. */
  path: string;
  /** Which memory directory it came from. */
  root: string;
  tags: string[];
}

export interface WorkspaceFile {
  version: 1;
  name: string;
  /**
   * Where work happens (DESIGN §3). One directory, and the agent's working
   * directory for the session.
   *
   * A path, or a path with something said about it — the same form every
   * directory in this file takes.
   */
  cwd?: WorkspaceDirRef;
  /**
   * Directories that are open alongside the cwd — other repositories, a spec
   * folder, anything worth having to hand. May sit inside the cwd or contain
   * it; nesting is allowed and is often the point.
   *
   * A plain string is the usual form. The object form is the same directory
   * with something else said about it — so far, that the file explorer should
   * leave it out (§3).
   */
  context?: WorkspaceDirRef[];
  /**
   * The flat list this replaced. Still read: the first entry becomes the cwd
   * and the rest become context, so an older workspace file opens unchanged.
   */
  directories?: string[];
  instructions?: string[];
  /** Extra directories to load skills from, on top of what Pi discovers. */
  skillPaths?: string[];
  skills?: WorkspaceResources;
  prompts?: WorkspaceResources;
  extensions?: WorkspaceResources;
  memory?: MemoryDirs;
  mcp?: Record<string, WorkspaceMcpConfig>;
  permissions?: WorkspacePermissions;
  /**
   * Which agent a new session starts with. Set by choosing one, the same way
   * choosing a model sets `models` — the file stays the persistent policy (§34).
   */
  agent?: AgentKind;
  /**
   * The model each agent was last given. Per agent because they do not share
   * a catalogue: `sonnet` means nothing to Pi and `openai/gpt-5` means nothing
   * to Claude, so one slot could only ever be right for one of them.
   */
  models?: Partial<Record<AgentKind, WorkspaceModel>>;
  /** The single slot this replaced. Still read, and still means Pi's model. */
  model?: WorkspaceModel;
  voice?: WorkspaceVoice;
}

/** A loaded workspace: the file plus where it came from. */
export interface Workspace {
  /** Absolute path of the workspace JSON file. */
  path: string;
  file: WorkspaceFile;
  /**
   * Every directory the workspace opens, resolved and existence-checked, in the
   * order they should be shown: the cwd, then context directories, then the
   * enabled memory directories (§50). Nesting is allowed, so a root may well be
   * inside another one.
   */
  roots: WorkspaceRoot[];
  /** The working directory, resolved. Null when the workspace names none. */
  cwd: string | null;
  /**
   * Memory directories after merging the global list with this workspace's.
   * Empty until the app fills it, since the loader cannot see global settings.
   */
  memory: ResolvedMemoryDir[];
  /** Non-fatal problems found while loading. */
  diagnostics: string[];
}

export interface WorkspaceRoot {
  /** Display name (basename of the directory). */
  name: string;
  /** Absolute, normalized path. */
  path: string;
  exists: boolean;
  /**
   * What this directory is for. `cwd` is where work happens, `context` is open
   * alongside it, and `memory` is the readable store described in §50.
   */
  kind: "cwd" | "context" | "memory";
  /** Whether the agent may write here. Always true for project directories. */
  writable: boolean;
  /** Reachable, but left out of the file explorer (§3). */
  hidden?: boolean;
}

export interface RecentWorkspace {
  path: string;
  name: string;
  openedAt: string;
}

export interface WorkspaceValidationError {
  path: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Path completion (workspace picker)
// ---------------------------------------------------------------------------

export interface PathCompletion {
  path: string;
  name: string;
  type: "directory" | "file" | "drive";
  /** True for `*.workspace.json` and friends. */
  workspace?: boolean;
}

export interface PathCompleteResponse {
  /**
   * The folder the completions came from. When the typed path names a folder
   * that does not exist, this is the deepest ancestor that does, so the listing
   * is never empty and always says where it is.
   */
  base: string;
  /** Separator to join with — mirrors what the user is typing. */
  separator: "/" | "\\";
  completions: PathCompletion[];
  /** The typed folder does not exist; `base` is the nearest one that does. */
  missing: boolean;
}

export interface PathInspectResponse {
  path: string;
  exists: boolean;
  type: "directory" | "file" | null;
  /** Workspace files directly inside, when `path` is a directory. */
  workspaceFiles: string[];
  suggestedName: string;
  isGitRepo: boolean;
  /**
   * Where "up" leads. An empty string means the roots listing — home and the
   * drives — which is what sits above `C:\`; null means there is no up at all.
   */
  parent: string | null;
}

export interface CreateWorkspaceRequest {
  directory: string;
  name?: string;
  /**
   * Exact path to write, for when the user typed a filename rather than picking
   * a folder. Overrides `location`, and its parent becomes the directory.
   */
  file?: string;
  /** Where the JSON is written: beside the code, or in Picone's data directory. */
  location?: "inside" | "central";
}

// ---------------------------------------------------------------------------
// Files (DESIGN §12, §15)
// ---------------------------------------------------------------------------

export interface DirEntry {
  name: string;
  /** Absolute path. */
  path: string;
  type: "file" | "directory";
  /** Git status short code relative to the containing root, when known. */
  gitStatus?: GitStatus;
}

export type GitStatus = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflicted";

/**
 * How a file wants to be shown. `markdown` and `html` are the two that have a
 * rendered form worth reading; everything else is source or bytes.
 */
export type FileKind = "markdown" | "html" | "code" | "text" | "binary";

export interface FileContent {
  path: string;
  kind: FileKind;
  /** Language id used for syntax highlighting, e.g. "typescript". */
  language: string;
  content: string;
  /** True when the file was too large and `content` holds only a prefix. */
  truncated: boolean;
  size: number;
  /** mtimeMs, used to detect on-disk changes. */
  mtime: number;
}

/**
 * What the server can say about a path a message mentioned (DESIGN §51).
 *
 * `exists: false` covers both "no such file" and "outside the workspace" on
 * purpose. The browser only needs to know whether it may show the thing, and
 * telling it which of the two applies would confirm the existence of paths
 * outside the roots — the one fact the root guard is there to withhold.
 */
export interface ResolvedPath {
  /** Echoed exactly as asked, so the client can key its cache by it. */
  path: string;
  exists: boolean;
  /** Absolute, present only when it resolved. */
  absolute?: string;
  type?: "file" | "directory";
  /** The workspace root it belongs to, for display as a relative path. */
  root?: string;
  size?: number;
  mtime?: number;
}

// ---------------------------------------------------------------------------
// Sessions (DESIGN §26)
// ---------------------------------------------------------------------------

export interface SessionModel {
  provider: string;
  model: string;
  thinking?: string;
}

/**
 * Which agent is behind a session.
 *
 * Chosen per session rather than per workspace: the same project is worth
 * asking two different agents about, and a conversation cannot change its mind
 * halfway through — the history belongs to whoever has been having it.
 */
export type AgentKind = "pi" | "claude";

/**
 * What a session's agent can actually do.
 *
 * Agents differ in ways the UI has to respect. Rather than each surface
 * knowing which agent supports what, every session says so and the browser
 * draws only the affordances that exist: a rewind button that answers "not
 * supported" is worse than no rewind button.
 */
export interface AgentCapabilities {
  /** Going back to just before a message, in place (§53). */
  rewind: boolean;
  /** The same point in a session of its own (§53). */
  fork: boolean;
  /** Summarising the conversation on demand (§54). */
  compact: boolean;
  /** Compacting on its own when the context fills, as a switch (§54). */
  autoCompaction: boolean;
  /** Rebuilding the session's resources and prompt from the settings (§34). */
  reload: boolean;
  /** Writing the session out as HTML (§36). */
  exportHtml: boolean;
  /** Drawing an extension's own interface (§55). */
  extensionUi: boolean;
  /** Restoring the files, not just the conversation, to an earlier message. */
  fileCheckpoints: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Which agent is behind it. Absent on rows written before there was a choice. */
  agent?: AgentKind;
  /** What that agent can do, once the session is loaded. */
  capabilities?: AgentCapabilities;
  /**
   * What the agent needs to pick this session up again: Pi's session file, or
   * Claude's session id. `sessionFile` is the same thing under Pi's name, kept
   * for the rows that already have one.
   */
  resumeRef?: string;
  /** Pi session file backing this session, when persisted. */
  sessionFile?: string;
  /** Model this session is actually running, once it has been created. */
  model?: SessionModel;
  /** One line of the most recent message, for the session list (DESIGN §27). */
  excerpt?: string;
  /** The session this one was forked from (§53), when it was. */
  forkedFrom?: string;
}

/**
 * A page of older transcript, fetched when the browser scrolls back past what
 * it was given (DESIGN §14).
 */
export interface TranscriptPageResponse {
  items: ChatItem[];
  /** There is still history before this page. */
  hasMore: boolean;
}

/**
 * How full the model's context window is (DESIGN §54).
 *
 * `tokens` is null when Pi cannot say yet — right after compaction, before the
 * next reply comes back — so the UI has to handle "unknown" rather than zero.
 */
export interface ContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

/** Pi's thinking levels, lowest effort first. */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  /** False when the model has no thinking control at all. */
  reasoning: boolean;
  /**
   * The levels this model actually accepts, in canonical order. Models differ
   * widely — some cannot be turned off, some support only two levels — so the
   * UI must offer this rather than a fixed list.
   */
  thinkingLevels: ThinkingLevel[];
}

// ---------------------------------------------------------------------------
// Extension UI (mirrors Pi's RPC extension-UI surface)
// ---------------------------------------------------------------------------

/** Requests that block the extension until the human answers. */
export type ExtensionUiPrompt =
  | { id: string; method: "select"; title: string; options: string[] }
  | { id: string; method: "confirm"; title: string; message: string }
  | { id: string; method: "input"; title: string; placeholder?: string }
  | { id: string; method: "editor"; title: string; prefill?: string }
  /**
   * `ui.custom` — an interactive component the extension drives itself.
   *
   * Unlike the four above, this one has no question and no answer: it is a
   * screen that renders lines and consumes keystrokes until it decides it is
   * done. The browser shows the lines and forwards the keys; the component,
   * running on the server, does the rest.
   */
  | { id: string; method: "custom"; lines: WidgetLine[] };

export type ExtensionUiAnswer =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

/**
 * A run of text from an extension's widget, with the role it declared (§55).
 *
 * Extensions draw through Pi's theme — `theme.fg("success", "✓")` — so the role
 * is what the widget *meant*, not a colour to reproduce. The browser decides
 * what "success" looks like; an unrecognised or unstyled run has no role.
 */
export interface WidgetSpan {
  text: string;
  role?: string;
  bold?: boolean;
}

/** One rendered line. Empty means a blank line. */
export type WidgetLine = WidgetSpan[];

/** Fire-and-forget surfaces an extension can drive. */
export type ExtensionUiUpdate =
  | { method: "setStatus"; key: string; text: string | undefined }
  | { method: "setWidget"; key: string; lines: WidgetLine[] | undefined; placement?: "aboveEditor" | "belowEditor" }
  /**
   * `setHeader` and `setFooter`. Both take a component factory in Pi and are
   * rendered to lines the same way a factory widget is; they differ from a
   * widget only in where they sit, so they share one message.
   */
  | { method: "setChrome"; slot: "header" | "footer"; lines: WidgetLine[] | undefined }
  /** The label on the row shown while the agent works. */
  | { method: "setWorkingMessage"; message: string | undefined }
  /** Whether that row appears at all. */
  | { method: "setWorkingVisible"; visible: boolean }
  /**
   * The animation beside it. `frames` of one is a static glyph, `[]` hides the
   * indicator but keeps the row, and undefined restores the default spinner.
   */
  | { method: "setWorkingIndicator"; frames: string[] | undefined }
  /** What a collapsed thinking block is called. */
  | { method: "setHiddenThinkingLabel"; label: string | undefined }
  /** Whether tool output starts expanded. */
  | { method: "setToolsExpanded"; expanded: boolean }
  | { method: "setTitle"; title: string }
  | { method: "setEditorText"; text: string };

/** A slash command offered in the composer. */
export interface SlashCommand {
  name: string;
  description?: string;
  /** "app" commands are handled in the browser and never reach Pi. */
  source: "extension" | "prompt" | "skill" | "builtin" | "app";
}

export type AgentState = "idle" | "thinking" | "streaming" | "tool" | "waiting_permission";

// ---------------------------------------------------------------------------
// Comments (DESIGN §16)
// ---------------------------------------------------------------------------

export type CommentStatus = "open" | "addressed" | "resolved";

export interface FileComment {
  id: string;
  workspaceId: string;
  sessionId: string;
  path: string;
  /** The selected text — the primary anchor (DESIGN §17). */
  matcher: string;
  lineStart?: number;
  lineEnd?: number;
  body: string;
  status: CommentStatus;
  createdAt: string;
}

export interface FileCommentInput {
  type: "file_comment";
  path: string;
  matcher: string;
  lineStart?: number;
  lineEnd?: number;
  body: string;
  commentId: string;
}

// ---------------------------------------------------------------------------
// Permissions (DESIGN §10)
// ---------------------------------------------------------------------------

export interface PermissionRequest {
  id: string;
  category: PermissionCategory;
  /** Tool that triggered the request, e.g. "bash". */
  toolName: string;
  /** Human-readable title, e.g. "Pi wants to run". */
  title: string;
  /** The command or path the agent wants to act on. */
  detail: string;
  /** Working directory for shell/git requests. */
  cwd?: string;
  createdAt: string;
}

export type PermissionDecision = "allow_once" | "allow_session" | "deny";

// ---------------------------------------------------------------------------
// Tool calls
// ---------------------------------------------------------------------------

export interface ToolCall {
  id: string;
  name: string;
  /** Short human-readable summary of the arguments. */
  title: string;
  args: unknown;
  status: "running" | "ok" | "error" | "blocked";
  /** Text output, possibly partial while running. */
  output?: string;
  /** Unified patch for edit/write tools, when available. */
  patch?: string;
  /**
   * The structured result a tool attached to its output (DESIGN §56).
   *
   * Pi lets a tool return `details` alongside its text, and extensions use it
   * to say what they did in a form other than prose — the todo tool puts its
   * whole task list here. Kept so the browser can draw it rather than print it.
   * Capped on the way in: this is persisted with the transcript.
   */
  details?: unknown;
}

// ---------------------------------------------------------------------------
// Chat transcript
// ---------------------------------------------------------------------------

export type ChatItem =
  | {
      kind: "user";
      id: string;
      text: string;
      source?: "chat" | "voice" | "comment";
      at: string;
      /**
       * The Pi session entry this message became (DESIGN §53). Pi's session file
       * is a tree, and this is the only handle the browser has on a node in it —
       * without it there is nothing for "rewind to here" to address.
       */
      entryId?: string;
    }
  /** Output an extension pushed with `pi.sendMessage({ display: true })`. */
  | { kind: "extension"; id: string; customType: string; text: string; at: string }
  | { kind: "assistant"; id: string; text: string; thinking?: string; at: string }
  | { kind: "tool"; id: string; toolCall: ToolCall; at: string }
  | { kind: "permission"; id: string; request: PermissionRequest; decision?: PermissionDecision; at: string }
  | { kind: "notice"; id: string; text: string; level: "info" | "warn" | "error"; at: string };

// ---------------------------------------------------------------------------
// Server → client events (DESIGN §30)
// ---------------------------------------------------------------------------

export type AgentEvent =
  /**
   * The tail of the transcript (§14). `hasMore` is whether anything precedes
   * it — the browser cannot tell from the items alone, and without being told
   * it has to assume there might be.
   */
  | { type: "session.snapshot"; sessionId: string; items: ChatItem[]; state: AgentState; hasMore: boolean }
  /** Put text in the composer — a rewound message, ready to be said differently. */
  | { type: "editor.set"; text: string }
  /** How full the context is, sampled when it can have changed (§54). */
  | { type: "context.usage"; usage: ContextUsage | null }
  | { type: "user.message"; id: string; text: string; source: "chat" | "voice" | "comment"; at: string }
  | { type: "assistant.start"; id: string }
  | { type: "assistant.delta"; id: string; text: string }
  | { type: "assistant.thinking"; id: string; text: string }
  | { type: "assistant.end"; id: string; text: string }
  | { type: "extension.message"; id: string; customType: string; text: string; at: string }
  | { type: "tool.started"; toolCall: ToolCall }
  | { type: "tool.updated"; toolCall: ToolCall }
  | { type: "tool.completed"; toolCall: ToolCall }
  | { type: "permission.requested"; request: PermissionRequest }
  | { type: "permission.resolved"; requestId: string; decision: PermissionDecision }
  | { type: "file.changed"; path: string; mtime: number }
  | { type: "comment.created"; comment: FileComment }
  | { type: "comment.updated"; comment: FileComment }
  | { type: "voice.speak"; text: string }
  | { type: "agent.state"; state: AgentState }
  | { type: "notice"; text: string; level: "info" | "warn" | "error" }
  | { type: "workspace.updated"; workspace: Workspace }
  /** A startup restore is in flight (path) or finished (null). */
  | { type: "workspace.restoring"; path: string | null }
  | { type: "session.list"; sessions: SessionSummary[]; activeSessionId: string | null }
  | { type: "session.commands"; sessionId: string; commands: SlashCommand[] }
  | { type: "extension.ui.prompt"; prompt: ExtensionUiPrompt }
  | { type: "extension.ui.prompt.closed"; id: string }
  /** A `custom` component redrawing itself while it is open. */
  | { type: "extension.ui.frame"; id: string; lines: WidgetLine[] }
  | { type: "extension.ui.update"; update: ExtensionUiUpdate }
  | { type: "mcp.state"; servers: McpServerState[] };

/** Every server → client frame. `sessionId` is null for workspace-level events. */
export interface ServerFrame {
  sessionId: string | null;
  event: AgentEvent;
}

export interface McpServerState {
  name: string;
  enabled: boolean;
  status: "connected" | "error" | "disabled";
  toolCount: number;
  error?: string;
  /** Where the server was configured. Workspace entries override global ones. */
  source?: "global" | "workspace";
}

/**
 * Settings that apply to every workspace, read from `~/.picone/settings.json`.
 * Pi already discovers skills, extensions, and prompt templates itself; this
 * covers MCP, which Pi has no concept of, plus extra skill directories.
 */
export interface GlobalSettings {
  mcp: Record<string, WorkspaceMcpConfig>;
  skills: WorkspaceSkill[];
  /** Memory directories offered to every workspace (§50). */
  memory: MemoryDirs;
}

/**
 * One thing Pi discovered. Whether it is switched on is not recorded here — the
 * workspace file is the only answer to that, and it stays correct after a save,
 * which a snapshot of the running session would not.
 */
export interface ResourceInfo {
  name: string;
  description?: string;
  /** File it was loaded from; empty when only the name is known. */
  source: string;
  /** Load error, when it failed. */
  error?: string;
}

/** What Pi discovered for the active session, disabled entries included. */
export interface ResourceReport {
  extensions: ResourceInfo[];
  skills: ResourceInfo[];
  prompts: ResourceInfo[];
}

// ---------------------------------------------------------------------------
// Client → server messages (DESIGN §31)
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** `sessionId` targets a specific session; omitted means the active one. */
  /**
   * `display` is what the transcript shows when it differs from what the model
   * is given — a file mention reads as `@report.html` and is sent as the path
   * it stands for (§51).
   */
  | { type: "prompt"; text: string; display?: string; source?: "chat" | "voice"; sessionId?: string }
  | { type: "steer"; text: string; sessionId?: string }
  | { type: "abort"; sessionId?: string }
  | { type: "permission_response"; requestId: string; decision: PermissionDecision }
  | { type: "file_comment"; input: Omit<FileCommentInput, "type" | "commentId"> }
  | { type: "resolve_comment"; commentId: string; status: CommentStatus }
  | { type: "watch_file"; path: string }
  | { type: "unwatch_file"; path: string }
  | { type: "select_session"; sessionId: string }
  /** Move the leaf back to just before a message, in place (DESIGN §53). */
  | { type: "rewind"; itemId: string; sessionId?: string }
  /** Summarise the conversation so far and drop what it replaces (§54). */
  | { type: "compact"; sessionId?: string }
  /** Rebuild a session's resources and system prompt from the current settings. */
  | { type: "reload_session"; sessionId?: string }
  /** Pi's own tally for the session — messages, tokens, cost. */
  | { type: "session_stats"; sessionId?: string }
  /** Write the session out as HTML, through Pi's exporter. */
  | { type: "session_export"; sessionId?: string }
  /** `agent` picks the backend; omitted takes the workspace's default (§57). */
  | { type: "new_session"; title?: string; agent?: AgentKind }
  | { type: "extension_ui_answer"; answer: ExtensionUiAnswer }
  /** A keystroke for an open `custom` component, already in terminal form. */
  | { type: "extension_ui_key"; id: string; data: string }
  /** Mirrors composer contents so extensions can read and patch the editor. */
  | { type: "editor_text"; text: string }
  | { type: "ping" };

// ---------------------------------------------------------------------------
// REST payloads
// ---------------------------------------------------------------------------

export interface OpenWorkspaceRequest {
  path: string;
}

export interface WorkspaceStateResponse {
  workspace: Workspace | null;
  sessions: SessionSummary[];
  activeSessionId: string | null;
  model: { provider: string; model: string; thinking: string } | null;
  mcp: McpServerState[];
  voice: Required<WorkspaceVoice>;
  settings: GlobalSettings;
  /** Problems reading the global settings file. */
  settingsErrors: string[];
  resources: ResourceReport | null;
  /**
   * Whether Pi compacts on its own when the context fills (DESIGN §54).
   *
   * Pi's setting, not Picone's — it lives in Pi's own store and applies to the
   * CLI as well, so this is read from Pi rather than mirrored.
   */
  autoCompaction: boolean;
  /** Non-null while a workspace is being reopened at startup. */
  restoring: string | null;
}
