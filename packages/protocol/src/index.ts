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

export interface WorkspaceFile {
  version: 1;
  name: string;
  directories: string[];
  instructions?: string[];
  skills?: WorkspaceSkill[];
  mcp?: Record<string, WorkspaceMcpConfig>;
  permissions?: WorkspacePermissions;
  model?: WorkspaceModel;
  voice?: WorkspaceVoice;
}

/** A loaded workspace: the file plus where it came from. */
export interface Workspace {
  /** Absolute path of the workspace JSON file. */
  path: string;
  file: WorkspaceFile;
  /** Roots resolved to absolute paths, with existence checked. */
  roots: WorkspaceRoot[];
  /** Non-fatal problems found while loading. */
  diagnostics: string[];
}

export interface WorkspaceRoot {
  /** Display name (basename of the directory). */
  name: string;
  /** Absolute, normalized path. */
  path: string;
  exists: boolean;
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
  base: string;
  /** Separator to join with — mirrors what the user is typing. */
  separator: "/" | "\\";
  completions: PathCompletion[];
  /** The base directory does not exist. */
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
  parent: string | null;
}

export interface CreateWorkspaceRequest {
  directory: string;
  name?: string;
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
  /** Present for files. */
  size?: number;
  /** Git status short code relative to the containing root, when known. */
  gitStatus?: GitStatus;
}

export type GitStatus = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflicted";

export type FileKind = "markdown" | "code" | "text" | "binary";

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

// ---------------------------------------------------------------------------
// Sessions (DESIGN §26)
// ---------------------------------------------------------------------------

export interface SessionModel {
  provider: string;
  model: string;
  thinking?: string;
}

export interface SessionSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  /** Pi session file backing this session, when persisted. */
  sessionFile?: string;
  /** Model this session is actually running, once it has been created. */
  model?: SessionModel;
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
  | { id: string; method: "editor"; title: string; prefill?: string };

export type ExtensionUiAnswer =
  | { id: string; value: string }
  | { id: string; confirmed: boolean }
  | { id: string; cancelled: true };

/** Fire-and-forget surfaces an extension can drive. */
export type ExtensionUiUpdate =
  | { method: "setStatus"; key: string; text: string | undefined }
  | { method: "setWidget"; key: string; lines: string[] | undefined; placement?: "aboveEditor" | "belowEditor" }
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
}

// ---------------------------------------------------------------------------
// Chat transcript
// ---------------------------------------------------------------------------

export type ChatItem =
  | { kind: "user"; id: string; text: string; source?: "chat" | "voice" | "comment"; at: string }
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
  | { type: "session.snapshot"; sessionId: string; items: ChatItem[]; state: AgentState }
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
 * Settings that apply to every workspace. Pi already discovers global skills,
 * extensions, and prompt templates itself; this covers MCP, which Pi has no
 * concept of, plus extra skill directories.
 */
export interface GlobalSettings {
  mcp: Record<string, WorkspaceMcpConfig>;
  skills: WorkspaceSkill[];
  /**
   * Pi extensions to leave out, by name. Picone filters them at session load;
   * it never edits Pi's own settings, where installing and removing packages
   * belongs to `pi install`.
   */
  disabledExtensions: string[];
}

/** A Pi extension discovered for the active session. */
export interface ExtensionInfo {
  name: string;
  path: string;
  enabled: boolean;
  /** Load error, when the extension failed. */
  error?: string;
}

/** What Pi discovered and loaded for the active session. */
export interface ResourceReport {
  extensions: ExtensionInfo[];
  skills: Array<{ name: string; description: string; source: string }>;
  prompts: Array<{ name: string; description?: string; source: string }>;
}

// ---------------------------------------------------------------------------
// Client → server messages (DESIGN §31)
// ---------------------------------------------------------------------------

export type ClientMessage =
  /** `sessionId` targets a specific session; omitted means the active one. */
  | { type: "prompt"; text: string; source?: "chat" | "voice"; sessionId?: string }
  | { type: "steer"; text: string; sessionId?: string }
  | { type: "abort"; sessionId?: string }
  | { type: "permission_response"; requestId: string; decision: PermissionDecision }
  | { type: "file_comment"; input: Omit<FileCommentInput, "type" | "commentId"> }
  | { type: "resolve_comment"; commentId: string; status: CommentStatus }
  | { type: "watch_file"; path: string }
  | { type: "unwatch_file"; path: string }
  | { type: "select_session"; sessionId: string }
  | { type: "new_session"; title?: string }
  | { type: "extension_ui_answer"; answer: ExtensionUiAnswer }
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
  /** Non-null while a workspace is being reopened at startup. */
  restoring: string | null;
}
