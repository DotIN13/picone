import { createStore, produce, reconcile } from "solid-js/store";
import type {
  AgentState,
  ChatItem,
  CommentStatus,
  CreateWorkspaceRequest,
  DirEntry,
  ExtensionUiAnswer,
  ExtensionUiPrompt,
  FileComment,
  FileContent,
  GlobalSettings,
  GitStatus,
  McpServerState,
  ModelOption,
  PermissionDecision,
  ResourceReport,
  ServerFrame,
  SessionSummary,
  SlashCommand,
  Workspace,
  WorkspaceStateResponse,
} from "@picone/protocol";
import { api } from "./lib/api.ts";
import {
  applyAppearance,
  defaultAppSettings,
  loadAppSettings,
  notify,
  resolveColorScheme,
  saveAppSettings,
  watchSystemColorScheme,
  type AppSettings,
} from "./lib/app-settings.ts";
import { socket } from "./lib/socket.ts";
import { speak } from "./voice/speech.ts";

export interface SessionTab {
  kind: "session";
  /** Tab id is the session id. */
  id: string;
  name: string;
}

export interface FileTabModel {
  kind: "file";
  /** Tab id is the absolute path. */
  id: string;
  path: string;
  name: string;
}

export type Tab = SessionTab | FileTabModel;

export interface OpenFileState {
  content: FileContent | null;
  loading: boolean;
  error: string | null;
  /** Set when the file changed on disk while the tab is open (DESIGN §24). */
  staleMtime: number | null;
  markdownSource: boolean;
}

export type ColorScheme = "light" | "dark";

export type { AppSettings } from "./lib/app-settings.ts";

interface State {
  connected: boolean;
  workspace: Workspace | null;
  sessions: SessionSummary[];
  /** The session that receives chat, voice, and comments — the last focused session tab. */
  activeSessionId: string | null;
  /** Transcripts keyed by session, so background sessions keep accumulating. */
  transcripts: Record<string, ChatItem[]>;
  agentStates: Record<string, AgentState>;
  commands: Record<string, SlashCommand[]>;
  comments: FileComment[];
  mcp: McpServerState[];
  models: ModelOption[];
  voice: { input: boolean; output: boolean };
  /** Settings shared by every workspace. */
  settings: GlobalSettings;
  settingsErrors: string[];
  /** What Pi discovered for the active session — extensions, skills, prompts. */
  resources: ResourceReport | null;
  /** Path being reopened at startup; the picker waits rather than butting in. */
  restoring: string | null;

  /** Blocking extension dialogs, oldest first. */
  extensionPrompts: ExtensionUiPrompt[];
  /** `setStatus` entries, keyed as the extension keyed them. */
  extensionStatus: Record<string, string>;
  /** `setWidget` line blocks around the composer. */
  extensionWidgets: Record<string, { lines: string[]; placement: "aboveEditor" | "belowEditor" }>;
  /** Text an extension pushed into the composer, consumed by the Composer. */
  editorPatch: { text: string; at: number } | null;

  tabs: Tab[];
  activeTabId: string | null;
  files: Record<string, OpenFileState>;

  tree: Record<string, DirEntry[]>;
  expanded: Record<string, boolean>;
  treeLoading: Record<string, boolean>;
  gitStatus: Record<string, GitStatus>;

  filter: string;
  filterResults: DirEntry[];
  sidebarMode: "files" | "sessions";
  /** Desktop: the sidebar is hidden. Compact: irrelevant, it is an overlay. */
  sidebarCollapsed: boolean;
  /** Compact only: the sidebar overlay is showing. */
  sidebarOverlayOpen: boolean;
  /** Phone-shaped layout: overlay sidebar, sheets instead of dialogs. */
  compact: boolean;
  /** Touch-first device. */
  coarse: boolean;
  settingsOpen: boolean;
  workspacePickerOpen: boolean;
  /** This device's own preferences, not the workspace's (DESIGN §49). */
  app: AppSettings;
  /** What the theme preference resolves to right now — `system` included. */
  colorScheme: ColorScheme;
  toast: { text: string; level: "info" | "warn" | "error" } | null;
}

const [state, setState] = createStore<State>({
  connected: false,
  workspace: null,
  sessions: [],
  activeSessionId: null,
  transcripts: {},
  agentStates: {},
  commands: {},
  comments: [],
  mcp: [],
  models: [],
  voice: { input: true, output: true },
  settings: { mcp: {}, skills: [] },
  settingsErrors: [],
  resources: null,
  restoring: null,

  extensionPrompts: [],
  extensionStatus: {},
  extensionWidgets: {},
  editorPatch: null,

  tabs: [],
  activeTabId: null,
  files: {},

  tree: {},
  expanded: {},
  treeLoading: {},
  gitStatus: {},

  filter: "",
  filterResults: [],
  sidebarMode: "files",
  sidebarCollapsed: false,
  sidebarOverlayOpen: false,
  compact: false,
  coarse: false,
  settingsOpen: false,
  workspacePickerOpen: false,
  app: loadAppSettings(),
  colorScheme: "dark",
  toast: null,
});

export { state };

// --- derived ---------------------------------------------------------------

export function activeSessionState(): AgentState {
  return (state.activeSessionId && state.agentStates[state.activeSessionId]) || "idle";
}

export function transcriptOf(sessionId: string): ChatItem[] {
  return state.transcripts[sessionId] ?? [];
}

export function sessionSummary(sessionId: string): SessionSummary | undefined {
  return state.sessions.find((s) => s.id === sessionId);
}

/** Title for a notification, which has no session tab to give it context. */
function sessionName(sessionId: string): string {
  return sessionSummary(sessionId)?.title ?? "Picone";
}

export function hasSessionTab(): boolean {
  return state.tabs.some((tab) => tab.kind === "session");
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export async function init(): Promise<void> {
  applyAppearanceNow();
  watchSystemColorScheme(applyAppearanceNow);
  socket.onStatus((connected) => setState("connected", connected));
  socket.onFrame(applyFrame);
  socket.connect();
  await refreshState();
  void api
    .models()
    .then(({ models }) => setState("models", models))
    .catch(() => setState("models", []));
}

export async function refreshState(): Promise<void> {
  const next = await api.state();
  setState({
    workspace: next.workspace,
    sessions: next.sessions,
    mcp: next.mcp,
    voice: next.voice,
    settings: next.settings,
    settingsErrors: next.settingsErrors,
    resources: next.resources,
    restoring: next.restoring,
    // Do not offer the picker while a workspace is still being reopened.
    workspacePickerOpen: next.workspace === null && next.restoring === null,
  });

  if (!next.workspace) return;

  // Open the server's active session as the first tab.
  if (next.activeSessionId && !state.tabs.some((t) => t.id === next.activeSessionId)) {
    const summary = next.sessions.find((s) => s.id === next.activeSessionId);
    addSessionTab(next.activeSessionId, summary?.title ?? "Session");
    setState({ activeSessionId: next.activeSessionId, activeTabId: next.activeSessionId });
    void ensureCommands(next.activeSessionId);
  }

  const { comments } = await api.comments();
  setState("comments", comments);

  // Roots start expanded — one level, lazily (DESIGN §12).
  for (const root of next.workspace.roots.filter((r) => r.exists)) {
    setState("expanded", root.path, true);
    void loadDirectory(root.path);
  }
  void refreshGitStatus();
}

// ---------------------------------------------------------------------------
// App settings (DESIGN §49)
// ---------------------------------------------------------------------------

/** Applied and persisted as soon as they change — there is nothing to save. */
export function updateAppSettings(changes: {
  appearance?: Partial<AppSettings["appearance"]>;
  notifications?: Partial<AppSettings["notifications"]>;
}): void {
  const next: AppSettings = {
    appearance: { ...state.app.appearance, ...changes.appearance },
    notifications: { ...state.app.notifications, ...changes.notifications },
  };
  setState("app", next);
  saveAppSettings(next);
  if (changes.appearance) applyAppearanceNow();
}

/** Push appearance into the DOM, and mirror what `system` resolved to. */
function applyAppearanceNow(): void {
  applyAppearance(state.app.appearance);
  setState("colorScheme", resolveColorScheme(state.app.appearance.colorScheme));
}

export function resetAppSettings(): void {
  const next = defaultAppSettings();
  setState("app", next);
  saveAppSettings(next);
  applyAppearanceNow();
}

/**
 * The title bar's one-tap toggle: pick the opposite of what is on screen, which
 * turns a `system` preference into the explicit choice the tap implies.
 */
export function toggleColorScheme(): void {
  updateAppSettings({ appearance: { colorScheme: state.colorScheme === "dark" ? "light" : "dark" } });
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function addSessionTab(sessionId: string, name: string): void {
  setState("tabs", (tabs) => [...tabs, { kind: "session", id: sessionId, name }]);
}

/** Open (or focus) a session as a tab and make it the target for input. */
export async function openSession(sessionId: string): Promise<void> {
  const summary = sessionSummary(sessionId);
  if (!state.tabs.some((tab) => tab.id === sessionId)) {
    addSessionTab(sessionId, summary?.title ?? "Session");
  }
  setState({ activeTabId: sessionId, activeSessionId: sessionId, sidebarOverlayOpen: false });
  await api.selectSession(sessionId).catch((err: Error) => setState("toast", { text: err.message, level: "error" }));
  void ensureCommands(sessionId);
}

/**
 * The server pushes commands when a session is created or selected, but a
 * session restored before this tab connected has none cached yet.
 */
export async function ensureCommands(sessionId: string): Promise<void> {
  if (state.commands[sessionId]?.length) return;
  try {
    const { commands } = await api.sessionCommands(sessionId);
    setState("commands", sessionId, commands);
  } catch {
    /* commands are an affordance, not a requirement */
  }
}

export async function newSession(): Promise<void> {
  const { session } = await api.createSession("New session");
  addSessionTab(session.id, session.title);
  setState({ activeTabId: session.id, activeSessionId: session.id });
}

export async function openFile(path: string): Promise<void> {
  if (!state.tabs.some((t) => t.id === path)) {
    const name = path.split(/[\\/]/).pop() ?? path;
    setState("tabs", (tabs) => [...tabs, { kind: "file", id: path, path, name }]);
  }
  // Picking a file from the overlay sidebar dismisses it, as a native drawer would.
  setState({ activeTabId: path, sidebarOverlayOpen: false });

  if (state.files[path]?.content) return;
  setState("files", path, { content: null, loading: true, error: null, staleMtime: null, markdownSource: false });
  socket.send({ type: "watch_file", path });
  await reloadFile(path);
}

export async function reloadFile(path: string): Promise<void> {
  try {
    const content = await api.readFile(path);
    setState("files", path, (file) => ({
      content,
      loading: false,
      error: null,
      staleMtime: null,
      markdownSource: file?.markdownSource ?? false,
    }));
  } catch (err) {
    setState("files", path, (file) => ({
      content: file?.content ?? null,
      loading: false,
      error: (err as Error).message,
      staleMtime: null,
      markdownSource: file?.markdownSource ?? false,
    }));
  }
}

/** Closing a session tab hides it; the session itself keeps running server-side. */
export function closeTab(id: string): void {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  if (tab.kind === "file") socket.send({ type: "unwatch_file", path: id });

  setState(
    produce((s) => {
      const index = s.tabs.findIndex((t) => t.id === id);
      s.tabs = s.tabs.filter((t) => t.id !== id);
      if (tab.kind === "file") delete s.files[id];
      else delete s.transcripts[id];

      if (s.activeTabId === id) {
        s.activeTabId = s.tabs[Math.min(index, s.tabs.length - 1)]?.id ?? null;
      }
      if (tab.kind === "session" && s.activeSessionId === id) {
        // Input needs somewhere to go: fall back to another open session tab.
        s.activeSessionId = s.tabs.find((t) => t.kind === "session")?.id ?? null;
      }
    }),
  );

  const nextSession = state.activeSessionId;
  if (tab.kind === "session" && nextSession) void api.selectSession(nextSession).catch(() => {});
}

export function setActiveTab(id: string): void {
  const tab = state.tabs.find((t) => t.id === id);
  if (!tab) return;
  setState("activeTabId", id);
  if (tab.kind === "session" && state.activeSessionId !== id) {
    setState("activeSessionId", id);
    void api.selectSession(id).catch(() => {});
  }
}

/** Drag-and-drop reorder: move `draggedId` to just before or after `targetId`. */
export function moveTab(draggedId: string, targetId: string, side: "before" | "after"): void {
  if (draggedId === targetId) return;
  setState(
    produce((s) => {
      const from = s.tabs.findIndex((t) => t.id === draggedId);
      if (from === -1) return;
      const [moved] = s.tabs.splice(from, 1);
      if (!moved) return;
      const target = s.tabs.findIndex((t) => t.id === targetId);
      if (target === -1) {
        s.tabs.splice(from, 0, moved);
        return;
      }
      s.tabs.splice(side === "before" ? target : target + 1, 0, moved);
    }),
  );
}

export function toggleMarkdownSource(path: string): void {
  setState("files", path, "markdownSource", (value) => !value);
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

export async function toggleDirectory(path: string): Promise<void> {
  const wasExpanded = state.expanded[path] ?? false;
  setState("expanded", path, !wasExpanded);
  if (!wasExpanded && !state.tree[path]) await loadDirectory(path);
}

export async function loadDirectory(path: string): Promise<void> {
  if (state.treeLoading[path]) return;
  setState("treeLoading", path, true);
  try {
    const { entries } = await api.listDirectory(path);
    setState("tree", path, entries);
  } catch (err) {
    setState("toast", { text: (err as Error).message, level: "error" });
  } finally {
    setState("treeLoading", path, false);
  }
}

export async function refreshGitStatus(): Promise<void> {
  try {
    const { roots } = await api.gitChanges();
    const gitStatus: Record<string, GitStatus> = {};
    for (const root of roots) for (const change of root.changes) gitStatus[change.path] = change.status;
    setState("gitStatus", reconcile(gitStatus));
  } catch {
    /* git status is decoration, never an error the user must see */
  }
}

export function setFilter(value: string): void {
  setState("filter", value);
  if (value.trim().length < 2) {
    setState("filterResults", []);
    return;
  }
  void api
    .searchFiles(value.trim())
    .then(({ results }) => {
      if (state.filter === value) setState("filterResults", results);
    })
    .catch(() => setState("filterResults", []));
}

// ---------------------------------------------------------------------------
// UI toggles
// ---------------------------------------------------------------------------

export function setSidebarMode(mode: "files" | "sessions"): void {
  setState("sidebarMode", mode);
}

/** One control, two behaviours: an overlay on phones, a column on desktop. */
export function toggleSidebar(): void {
  if (state.compact) setState("sidebarOverlayOpen", (v) => !v);
  else setState("sidebarCollapsed", (v) => !v);
}

export function closeSidebarOverlay(): void {
  setState("sidebarOverlayOpen", false);
}

export function setLayout(layout: { compact?: boolean; coarse?: boolean }): void {
  if (layout.compact !== undefined && layout.compact !== state.compact) {
    setState("compact", layout.compact);
    // Leaving compact should never strand the app with a hidden sidebar.
    if (!layout.compact) setState({ sidebarOverlayOpen: false, sidebarCollapsed: false });
  }
  if (layout.coarse !== undefined) setState("coarse", layout.coarse);
}
export function setSettingsOpen(open: boolean): void {
  setState("settingsOpen", open);
}
export function setWorkspacePickerOpen(open: boolean): void {
  setState("workspacePickerOpen", open);
}
export function dismissToast(): void {
  setState("toast", null);
}
export function showToast(text: string, level: "info" | "warn" | "error" = "info"): void {
  setState("toast", { text, level });
}

// ---------------------------------------------------------------------------
// Session input
// ---------------------------------------------------------------------------

export function sendPrompt(text: string, source: "chat" | "voice" = "chat"): void {
  const sessionId = state.activeSessionId;
  if (!text.trim() || !sessionId) return;
  socket.send({ type: "prompt", text, source, sessionId });
}

export function abort(): void {
  if (!state.activeSessionId) return;
  socket.send({ type: "abort", sessionId: state.activeSessionId });
}

export async function setSessionModel(provider: string, model: string, thinking?: string): Promise<void> {
  const sessionId = state.activeSessionId;
  if (!sessionId) return;
  try {
    await api.setSessionModel(sessionId, provider, model, thinking);
  } catch (err) {
    showToast((err as Error).message, "error");
  }
}

// ---------------------------------------------------------------------------
// Extension UI
// ---------------------------------------------------------------------------

export function answerExtensionUi(answer: ExtensionUiAnswer): void {
  socket.send({ type: "extension_ui_answer", answer });
  setState("extensionPrompts", (prompts) => prompts.filter((p) => p.id !== answer.id));
}

/** Mirror the composer so extensions can read it via `getEditorText()`. */
export function reportEditorText(text: string): void {
  socket.send({ type: "editor_text", text });
}

export function consumeEditorPatch(): void {
  setState("editorPatch", null);
}

export function widgetsAt(placement: "aboveEditor" | "belowEditor"): string[][] {
  return Object.values(state.extensionWidgets)
    .filter((widget) => widget.placement === placement)
    .map((widget) => widget.lines);
}

export function respondPermission(requestId: string, decision: PermissionDecision): void {
  socket.send({ type: "permission_response", requestId, decision });
  for (const sessionId of Object.keys(state.transcripts)) {
    setState(
      "transcripts",
      sessionId,
      (item) => item.kind === "permission" && item.request.id === requestId,
      produce((item) => {
        if (item.kind === "permission") item.decision = decision;
      }),
    );
  }
}

export function addComment(input: {
  path: string;
  matcher: string;
  lineStart?: number;
  lineEnd?: number;
  body: string;
}): void {
  if (!state.activeSessionId) {
    showToast("Open a session before commenting.", "warn");
    return;
  }
  socket.send({ type: "file_comment", input });
}

export async function setCommentStatus(id: string, status: CommentStatus): Promise<void> {
  await api.setCommentStatus(id, status);
}

// ---------------------------------------------------------------------------
// Sessions and workspace
// ---------------------------------------------------------------------------

export async function deleteSession(id: string): Promise<void> {
  await api.deleteSession(id);
  if (state.tabs.some((t) => t.id === id)) closeTab(id);
}

export async function renameSession(id: string, title: string): Promise<void> {
  await api.renameSession(id, title);
  setState("tabs", (tab) => tab.id === id, "name", title);
}

/**
 * Everything scoped to the old workspace has to go, or tabs and transcripts
 * from it linger over the new one.
 */
function adoptWorkspace(next: WorkspaceStateResponse): void {
  setState({
    workspace: next.workspace,
    sessions: next.sessions,
    activeSessionId: null,
    mcp: next.mcp,
    voice: next.voice,
    workspacePickerOpen: false,
    sidebarOverlayOpen: false,
    tabs: [],
    activeTabId: null,
    files: {},
    tree: {},
    expanded: {},
    transcripts: {},
    agentStates: {},
    commands: {},
    comments: [],
    filter: "",
    filterResults: [],
  });
}

export async function openWorkspace(path: string): Promise<void> {
  const { state: next } = await api.openWorkspace(path);
  adoptWorkspace(next);
  await refreshState();
}

/** Create a workspace from a directory and open it (DESIGN §3). */
export async function createWorkspace(request: CreateWorkspaceRequest): Promise<void> {
  const { state: next } = await api.createWorkspace(request);
  adoptWorkspace(next);
  await refreshState();
}

// ---------------------------------------------------------------------------
// Event application
// ---------------------------------------------------------------------------

/** Fold a server event into the right session's transcript. */
function applyFrame(frame: ServerFrame): void {
  const { event } = frame;
  const sid = frame.sessionId;

  switch (event.type) {
    case "session.snapshot":
      setState("transcripts", event.sessionId, event.items);
      setState("agentStates", event.sessionId, event.state);
      break;

    case "user.message":
      if (sid) upsert(sid, { kind: "user", id: event.id, text: event.text, source: event.source, at: event.at });
      break;

    case "assistant.start":
      if (sid) upsert(sid, { kind: "assistant", id: event.id, text: "", at: new Date().toISOString() });
      break;

    case "assistant.delta":
      if (sid) {
        setState(
          "transcripts",
          sid,
          (item) => item.kind === "assistant" && item.id === event.id,
          produce((item) => {
            if (item.kind === "assistant") item.text += event.text;
          }),
        );
      }
      break;

    case "assistant.thinking":
      if (sid) {
        setState(
          "transcripts",
          sid,
          (item) => item.kind === "assistant" && item.id === event.id,
          produce((item) => {
            if (item.kind === "assistant") item.thinking = (item.thinking ?? "") + event.text;
          }),
        );
      }
      break;

    case "assistant.end":
      if (sid) {
        setState(
          "transcripts",
          sid,
          produce((items) => {
            const index = items.findIndex((i) => i.kind === "assistant" && i.id === event.id);
            if (index === -1) return;
            const item = items[index]!;
            if (item.kind !== "assistant") return;
            if (event.text) item.text = event.text;
            // Drop assistant turns that produced nothing but tool calls.
            if (!item.text.trim() && !item.thinking) items.splice(index, 1);
          }),
        );
      }
      break;

    case "extension.message":
      if (sid) {
        upsert(sid, {
          kind: "extension",
          id: event.id,
          customType: event.customType,
          text: event.text,
          at: event.at,
        });
      }
      break;

    case "tool.started":
    case "tool.updated":
    case "tool.completed":
      if (sid) {
        upsert(sid, { kind: "tool", id: event.toolCall.id, toolCall: event.toolCall, at: new Date().toISOString() });
      }
      break;

    case "permission.requested":
      if (sid) {
        upsert(sid, { kind: "permission", id: event.request.id, request: event.request, at: event.request.createdAt });
        setState("agentStates", sid, "waiting_permission");
        if (state.app.notifications.permissionNeeded) {
          notify(state.app.notifications, {
            title: `${sessionName(sid)} needs permission`,
            body: `${event.request.title} ${event.request.detail}`.trim(),
            tag: `permission:${sid}`,
            onClick: () => void openSession(sid),
          });
        }
      }
      break;

    case "permission.resolved":
      if (sid) {
        setState(
          "transcripts",
          sid,
          (item) => item.kind === "permission" && item.id === event.requestId,
          produce((item) => {
            if (item.kind === "permission") item.decision = event.decision;
          }),
        );
      }
      break;

    case "agent.state":
      if (sid) {
        // "Finished" is the edge into idle, not idleness itself — the same
        // state arrives repeatedly while nothing is happening.
        const wasWorking = (state.agentStates[sid] ?? "idle") !== "idle";
        setState("agentStates", sid, event.state);
        if (wasWorking && event.state === "idle" && state.app.notifications.turnFinished) {
          notify(state.app.notifications, {
            title: sessionName(sid),
            body: "Finished working.",
            tag: `turn:${sid}`,
            onClick: () => void openSession(sid),
          });
        }
      }
      break;

    case "notice":
      if (sid) {
        upsert(sid, {
          kind: "notice",
          id: `notice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          text: event.text,
          level: event.level,
          at: new Date().toISOString(),
        });
      }
      if (event.level === "error") {
        setState("toast", { text: event.text, level: event.level });
        if (state.app.notifications.errors) {
          notify(state.app.notifications, {
            title: sid ? `${sessionName(sid)} — error` : "Picone — error",
            body: event.text,
            onClick: sid ? () => void openSession(sid) : undefined,
          });
        }
      }
      break;

    case "file.changed": {
      if (!state.files[event.path]) break;
      // Never yank content out from under a selection — offer a refresh instead.
      setState("files", event.path, "staleMtime", event.mtime);
      void refreshGitStatus();
      break;
    }

    case "comment.created":
      setState("comments", (comments) => [...comments.filter((c) => c.id !== event.comment.id), event.comment]);
      break;

    case "comment.updated":
      setState("comments", (comments) => comments.map((c) => (c.id === event.comment.id ? event.comment : c)));
      break;

    case "voice.speak":
      if (state.voice.output) speak(event.text);
      break;

    case "workspace.updated":
      // A restore finishing must dismiss the picker if it opened meanwhile.
      setState({ workspace: event.workspace, workspacePickerOpen: false });
      void refreshState();
      break;

    case "workspace.restoring":
      setState("restoring", event.path);
      if (event.path) setState("workspacePickerOpen", false);
      else if (!state.workspace) setState("workspacePickerOpen", true);
      break;

    case "session.list":
      setState("sessions", event.sessions);
      // Keep tab titles in step with renames from anywhere.
      for (const summary of event.sessions) {
        setState("tabs", (tab) => tab.id === summary.id && tab.name !== summary.title, "name", summary.title);
      }
      break;

    case "session.commands":
      setState("commands", event.sessionId, event.commands);
      break;

    case "extension.ui.prompt":
      setState("extensionPrompts", (prompts) => [...prompts, event.prompt]);
      break;

    case "extension.ui.prompt.closed":
      // The server gave up on it (timeout or abort) — drop it silently.
      setState("extensionPrompts", (prompts) => prompts.filter((p) => p.id !== event.id));
      break;

    case "extension.ui.update": {
      const update = event.update;
      if (update.method === "setStatus") {
        if (update.text === undefined) {
          setState("extensionStatus", produce((status) => void delete status[update.key]));
        } else {
          setState("extensionStatus", update.key, update.text);
        }
      } else if (update.method === "setWidget") {
        if (update.lines === undefined) {
          setState("extensionWidgets", produce((widgets) => void delete widgets[update.key]));
        } else {
          setState("extensionWidgets", update.key, {
            lines: update.lines,
            placement: update.placement ?? "aboveEditor",
          });
        }
      } else if (update.method === "setTitle") {
        if (sid) setState("tabs", (tab) => tab.id === sid, "name", update.title);
      } else if (update.method === "setEditorText") {
        setState("editorPatch", { text: update.text, at: Date.now() });
      }
      break;
    }

    case "mcp.state":
      setState("mcp", event.servers);
      break;
  }
}

function upsert(sessionId: string, item: ChatItem): void {
  setState(
    produce((s) => {
      const items = s.transcripts[sessionId] ?? (s.transcripts[sessionId] = []);
      const index = items.findIndex((i) => i.id === item.id);
      if (index === -1) items.push(item);
      else items[index] = item;
    }),
  );
}
