import { randomUUID } from "node:crypto";
import type {
  AgentEvent,
  CommentStatus,
  ExtensionUiAnswer,
  FileComment,
  FileCommentInput,
  GlobalSettings,
  McpServerState,
  PermissionDecision,
  Workspace,
  WorkspaceFile,
  WorkspaceStateResponse,
} from "@picone/protocol";
import { createComment, listComments, markAddressed, setCommentStatus } from "./comments/comments.ts";
import { commentSummary, commentToInput, formatCommentForModel } from "./comments/matcher.ts";
import {
  deleteSession,
  getUiState,
  insertSession,
  listSessions,
  rememberWorkspace,
  setUiState,
  touchSession,
  updateSession,
} from "./db.ts";
import { OpenFileWatcher } from "./files/watcher.ts";
import { Hub } from "./hub.ts";
import { McpManager } from "./mcp/manager.ts";
import { memoryRoots, resolveMemoryDirs } from "./memory/registry.ts";
import { loadGlobalSettings, mergeMcp, saveGlobalSettings } from "./settings.ts";
import nodePath from "node:path";
import { expandPath } from "./util/paths.ts";
import { SessionRuntime } from "./pi/runtime.ts";
import { createWorkspace, type CreateWorkspaceOptions } from "./workspace/create.ts";
import { loadWorkspace } from "./workspace/loader.ts";
import { resolvedPermissions, resolvedVoice } from "./workspace/schema.ts";
import { describeWorkspaceChange, writeWorkspaceFile } from "./workspace/writer.ts";

const LAST_WORKSPACE_KEY = "lastWorkspace";

/**
 * The single active workspace (DESIGN §1: exactly one workspace is open at a time)
 * and everything scoped to it: MCP servers, sessions, file watches.
 */
export class App {
  readonly hub = new Hub();
  readonly mcp = new McpManager();
  readonly watcher: OpenFileWatcher;

  private workspace: Workspace | null = null;
  private readonly sessions = new Map<string, SessionRuntime>();
  private activeSessionId: string | null = null;
  private settings: GlobalSettings = { mcp: {}, skills: [], memory: {} };
  private settingsErrors: string[] = [];
  private mcpSources: Record<string, "global" | "workspace"> = {};
  /** Path being reopened at startup, while it is still in flight. */
  private restoring: string | null = null;

  constructor() {
    this.reloadSettings();
    this.watcher = new OpenFileWatcher((path, mtime) => {
      this.hub.publish(null, { type: "file.changed", path, mtime });
    });
  }

  // --- workspace -------------------------------------------------------------

  getWorkspace(): Workspace | null {
    return this.workspace;
  }

  requireWorkspace(): Workspace {
    if (!this.workspace) throw new Error("No workspace is open");
    return this.workspace;
  }

  get roots(): string[] {
    return this.workspace?.roots.map((r) => r.path) ?? [];
  }

  /**
   * Fill in what the loader could not see: the global memory list this
   * workspace's entries merge with, and the roots those directories add.
   * Every path that produces a `Workspace` goes through here (§50).
   */
  private withMemory(workspace: Workspace): Workspace {
    const diagnostics = [...workspace.diagnostics];
    const memory = resolveMemoryDirs({
      global: this.settings.memory,
      workspace: workspace.file.memory,
      workspaceDir: nodePath.dirname(workspace.path),
      diagnostics,
    });

    for (const dir of memory) {
      if (dir.enabled && !dir.exists) diagnostics.push(`Memory directory does not exist: ${dir.path}`);
    }

    return {
      ...workspace,
      memory,
      roots: [...workspace.roots.filter((root) => root.kind === "directory"), ...memoryRoots(memory)],
      diagnostics,
    };
  }

  async openWorkspace(path: string): Promise<Workspace> {
    await this.closeWorkspace();

    const workspace = this.withMemory(loadWorkspace(path));
    this.workspace = workspace;
    rememberWorkspace(workspace.path, workspace.file.name);
    setUiState(LAST_WORKSPACE_KEY, workspace.path);

    await this.startMcp();
    this.hub.publish(null, { type: "workspace.updated", workspace });

    // Reattach to the most recent session for this workspace, or start one.
    // A session whose Pi session file has gone missing must not block the open.
    const known = listSessions(workspace.path);
    const mostRecent = known[0];
    if (mostRecent) {
      try {
        await this.activateSession(mostRecent.id, mostRecent.title, mostRecent.sessionFile);
      } catch (err) {
        console.warn(`[picone] could not reopen session ${mostRecent.id}: ${(err as Error).message}`);
        await this.createSession("New session");
      }
    } else {
      await this.createSession("New session");
    }

    this.publishSessionList();
    return workspace;
  }

  /** Create a workspace from a directory and open it immediately (DESIGN §3). */
  async createAndOpenWorkspace(options: CreateWorkspaceOptions): Promise<Workspace> {
    const created = createWorkspace(options);
    return this.openWorkspace(created.path);
  }

  async closeWorkspace(): Promise<void> {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.activeSessionId = null;
    await this.watcher.reset();
    await this.mcp.stop();
    this.workspace = null;
  }

  /**
   * Restore the workspace that was open when the server last ran.
   *
   * Runs after the port is open, so `restoring` exists to tell a client that
   * connects mid-restore to wait rather than offer the picker.
   */
  async restoreLastWorkspace(): Promise<void> {
    const last = getUiState<string>(LAST_WORKSPACE_KEY);
    if (!last) return;

    this.restoring = last;
    this.hub.publish(null, { type: "workspace.restoring", path: last });
    try {
      await this.openWorkspace(last);
    } catch (err) {
      // A workspace that no longer loads must not wedge every future start.
      setUiState(LAST_WORKSPACE_KEY, null);
      this.hub.publish(null, {
        type: "notice",
        text: `Could not reopen ${last}: ${(err as Error).message}`,
        level: "warn",
      });
      throw err;
    } finally {
      this.restoring = null;
      this.hub.publish(null, { type: "workspace.restoring", path: null });
    }
  }

  /**
   * Apply a settings edit: write the JSON file, reload it, and tell the running
   * session what changed (DESIGN §34).
   */
  async updateWorkspaceFile(next: WorkspaceFile): Promise<Workspace> {
    const current = this.requireWorkspace();
    const before = current.file;
    const workspace = this.withMemory(writeWorkspaceFile(current.path, next));
    this.workspace = workspace;

    for (const session of this.sessions.values()) session.updateWorkspace(workspace);

    if (JSON.stringify(before.mcp ?? {}) !== JSON.stringify(workspace.file.mcp ?? {})) {
      await this.startMcp();
    }

    this.hub.publish(null, { type: "workspace.updated", workspace });

    const description = describeWorkspaceChange(before, workspace.file);
    const active = this.activeSession();
    if (description && active) {
      void active.notifyWorkspaceChange(description).catch(() => {});
    }

    return workspace;
  }

  state(): WorkspaceStateResponse {
    const workspace = this.workspace;
    return {
      workspace,
      // Every session in the workspace, not just the loaded ones. Idle sessions
      // are evicted (§38), so the loaded set is a cache, and a sidebar built
      // from it silently lost rows the longer the app stayed open.
      sessions: this.allSessions(),
      activeSessionId: this.activeSessionId,
      model: workspace?.file.model
        ? {
            provider: workspace.file.model.provider ?? "",
            model: workspace.file.model.model ?? "",
            thinking: workspace.file.model.thinking ?? "",
          }
        : null,
      mcp: this.mcpState(),
      voice: workspace ? resolvedVoice(workspace.file) : { input: true, output: true },
      settings: this.settings,
      settingsErrors: this.settingsErrors,
      restoring: this.restoring,
      resources: this.activeSession()?.resources() ?? null,
    };
  }

  // --- global settings -------------------------------------------------------

  getSettings(): { settings: GlobalSettings; errors: string[] } {
    return { settings: this.settings, errors: this.settingsErrors };
  }

  /**
   * Save global settings and apply what can be applied live. MCP restarts
   * immediately; skills and extensions are read when a session is built, so
   * those take effect for sessions created afterwards.
   */
  async saveSettings(next: GlobalSettings): Promise<{ settings: GlobalSettings; errors: string[] }> {
    const before = JSON.stringify(this.settings.mcp);
    const saved = saveGlobalSettings(next);
    this.settings = saved.settings;
    this.settingsErrors = saved.errors;

    if (this.workspace && JSON.stringify(this.settings.mcp) !== before) await this.startMcp();

    // Memory directories are global too, so the open workspace's roots and
    // context may have just changed under it.
    if (this.workspace) {
      const workspace = this.withMemory(this.workspace);
      this.workspace = workspace;
      for (const session of this.sessions.values()) session.updateWorkspace(workspace);
      this.hub.publish(null, { type: "workspace.updated", workspace });
    }

    this.hub.publish(null, { type: "mcp.state", servers: this.mcpState() });
    return { settings: this.settings, errors: this.settingsErrors };
  }

  private reloadSettings(): void {
    const loaded = loadGlobalSettings();
    this.settings = loaded.settings;
    this.settingsErrors = loaded.errors;
  }

  /** Global servers plus the workspace's, with the workspace winning by name. */
  private async startMcp(): Promise<void> {
    const { merged, sources } = mergeMcp(this.settings.mcp, this.workspace?.file.mcp);
    this.mcpSources = sources;
    await this.mcp.start(merged);
    this.hub.publish(null, { type: "mcp.state", servers: this.mcpState() });
  }

  private mcpState(): McpServerState[] {
    return this.mcp.state().map((server) => ({ ...server, source: this.mcpSources[server.name] }));
  }

  // --- sessions --------------------------------------------------------------

  activeSession(): SessionRuntime | null {
    return this.activeSessionId ? (this.sessions.get(this.activeSessionId) ?? null) : null;
  }

  requireActiveSession(): SessionRuntime {
    const session = this.activeSession();
    if (!session) throw new Error("No active session");
    return session;
  }

  async createSession(title = "New session"): Promise<SessionRuntime> {
    const workspace = this.requireWorkspace();
    const id = randomUUID();
    const runtime = await this.buildSession(id, title, undefined);

    insertSession(workspace.path, runtime.summary());
    this.sessions.set(id, runtime);
    this.activeSessionId = id;
    this.publishSessionList();
    this.publishCommands(id);
    return runtime;
  }

  async selectSession(id: string): Promise<void> {
    if (this.activeSessionId === id && this.sessions.has(id)) return;

    if (!this.sessions.has(id)) {
      const workspace = this.requireWorkspace();
      const known = listSessions(workspace.path).find((s) => s.id === id);
      if (!known) throw new Error(`Unknown session ${id}`);
      await this.activateSession(known.id, known.title, known.sessionFile);
    } else {
      this.activeSessionId = id;
    }

    touchSession(id);
    this.publishSessionList();
    this.publishCommands(id);

    const runtime = this.sessions.get(id);
    if (runtime) this.hub.publish(id, runtime.snapshot());
  }

  async removeSession(id: string): Promise<void> {
    const runtime = this.sessions.get(id);
    runtime?.dispose();
    this.sessions.delete(id);
    deleteSession(id);
    if (this.activeSessionId === id) {
      const next = [...this.sessions.keys()][0];
      if (next) this.activeSessionId = next;
      else await this.createSession("New session");
    }
    this.publishSessionList();
  }

  /**
   * Rename, in both directions (DESIGN §26).
   *
   * A loaded session goes through Pi, so the name lands in the session file and
   * is there for the CLI too — and Pi sanitizes, so the stored title is what Pi
   * made of it rather than what was typed. A session that is not loaded has no
   * Pi to tell; it gets the name when it next opens, from `reconcileName`.
   */
  renameSession(id: string, title: string): void {
    const runtime = this.sessions.get(id);
    const stored = runtime ? runtime.rename(title) : title;
    if (runtime) runtime.title = stored;
    updateSession(id, { title: stored });
    this.publishSessionList();
  }

  /** Sessions known to this workspace, including ones not currently loaded. */
  allSessions() {
    const workspace = this.workspace;
    if (!workspace) return [];
    const loaded = new Map([...this.sessions.values()].map((s) => [s.id, s.summary()]));
    // The row is the base and the live runtime overlays it: only the runtime
    // knows the model, and only the row carries the excerpt, which is read from
    // the transcript rather than held in memory.
    return listSessions(workspace.path).map((row) => {
      const live = loaded.get(row.id);
      if (!live) return row;
      return { ...row, ...live, excerpt: row.excerpt, forkedFrom: live.forkedFrom ?? row.forkedFrom };
    });
  }

  private async activateSession(id: string, title: string, sessionFile?: string): Promise<void> {
    const runtime = await this.buildSession(id, title, sessionFile);
    this.sessions.set(id, runtime);
    this.activeSessionId = id;
    this.evictIdleSessions();
    this.publishCommands(id);
  }

  /**
   * Sessions stay loaded after you switch away so a background run keeps going,
   * but clicking through a long session list should not pin every Pi runtime in
   * memory. Idle, non-active sessions past the newest few are released; their
   * transcript and Pi session file persist, so reopening them is lossless.
   */
  private evictIdleSessions(keep = 4): void {
    const candidates = [...this.sessions.values()]
      .filter((s) => s.id !== this.activeSessionId && !s.isStreaming)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    for (const session of candidates.slice(Math.max(0, keep - 1))) {
      session.dispose();
      this.sessions.delete(session.id);
    }
  }

  private async buildSession(id: string, title: string, sessionFile?: string): Promise<SessionRuntime> {
    const workspace = this.requireWorkspace();
    return SessionRuntime.create({
      id,
      title,
      workspace,
      sessionFile,
      emit: (sessionId, event) => this.hub.publish(sessionId, event),
      extraTools: () => this.mcp.tools(),
      globalSkillPaths: this.settings.skills.map((skill) => expandPath(skill.path)),
      toolHooks: {
        markCommentAddressed: (commentId) => {
          const comment = markAddressed(commentId);
          if (comment) this.hub.publish(null, { type: "comment.updated", comment });
          return comment;
        },
        openComments: () => listComments(workspace.path).filter((c) => c.status === "open"),
      },
      onSessionFile: (sessionId, file) => updateSession(sessionId, { sessionFile: file }),
      // Pi renamed the session — from `/name` in a terminal, or an extension.
      onTitle: (sessionId, title) => {
        updateSession(sessionId, { title });
        this.publishSessionList();
      },
    });
  }

  private publishSessionList(): void {
    this.hub.publish(null, {
      type: "session.list",
      sessions: this.allSessions(),
      activeSessionId: this.activeSessionId,
    });
  }

  /** Slash commands are per-session: extensions and skills can differ. */
  publishCommands(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.hub.publish(null, { type: "session.commands", sessionId, commands: session.commands() });
  }

  // --- comments --------------------------------------------------------------

  /**
   * Save → show → inject (DESIGN §18). Steering vs. normal input is decided by
   * whether Pi is currently working.
   */
  async addComment(input: Omit<FileCommentInput, "type" | "commentId">): Promise<FileComment> {
    const workspace = this.requireWorkspace();
    const session = this.requireActiveSession();

    const comment = createComment(workspace.path, session.id, input);
    this.hub.publish(null, { type: "comment.created", comment });

    await session.injectComment(formatCommentForModel(commentToInput(comment)), commentSummary(comment));
    return comment;
  }

  setCommentStatus(commentId: string, status: CommentStatus): FileComment | null {
    const comment = setCommentStatus(commentId, status);
    if (comment) this.hub.publish(null, { type: "comment.updated", comment });
    return comment;
  }

  comments(): FileComment[] {
    return this.workspace ? listComments(this.workspace.path) : [];
  }

  // --- session input ---------------------------------------------------------

  /** Resolve an explicit session id, falling back to the active session. */
  private target(sessionId?: string): SessionRuntime {
    if (!sessionId) return this.requireActiveSession();
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} is not open`);
    return session;
  }

  async prompt(text: string, source: "chat" | "voice", sessionId?: string): Promise<void> {
    await this.target(sessionId).prompt(text, source);
  }

  async steer(text: string, sessionId?: string): Promise<void> {
    await this.target(sessionId).steer(text);
  }

  /** Go back to just before a message, in place (DESIGN §53). */
  async rewind(itemId: string, sessionId?: string): Promise<void> {
    await this.target(sessionId).rewind(itemId);
  }

  /**
   * The same point, in a session of its own — the original is left as it is.
   *
   * The new session opens with the message in its composer rather than already
   * having asked it, so a fork is a place to say something different rather
   * than a copy of a conversation that has already happened.
   */
  async fork(itemId: string, sessionId?: string): Promise<SessionRuntime> {
    const source = this.target(sessionId);
    const { sessionFile, text, history } = source.forkPoint(itemId);

    const workspace = this.requireWorkspace();
    const id = randomUUID();
    const runtime = await this.buildSession(id, forkTitle(source.title), sessionFile ?? undefined);
    runtime.forkedFrom = source.id;
    runtime.seedTranscript(history);

    insertSession(workspace.path, runtime.summary());
    this.sessions.set(id, runtime);
    this.activeSessionId = id;
    this.publishSessionList();
    this.publishCommands(id);
    this.hub.publish(id, runtime.snapshot());
    if (text) this.hub.publish(id, { type: "editor.set", text });
    return runtime;
  }

  async abort(sessionId?: string): Promise<void> {
    await this.target(sessionId).abort();
  }

  /**
   * Switch the model for one session and make it the workspace default, so new
   * sessions inherit the choice (DESIGN §34 — the JSON stays the persistent policy).
   */
  async setSessionModel(sessionId: string, provider: string, model: string, thinking?: string): Promise<void> {
    await this.target(sessionId).setModel(provider, model, thinking);

    const workspace = this.requireWorkspace();
    const next: WorkspaceFile = { ...workspace.file, model: { provider, model, thinking } };
    if (JSON.stringify(next.model) !== JSON.stringify(workspace.file.model)) {
      const updated = writeWorkspaceFile(workspace.path, next);
      this.workspace = updated;
      this.hub.publish(null, { type: "workspace.updated", workspace: updated });
    }
    this.publishSessionList();
  }

  commands(sessionId?: string) {
    return this.target(sessionId).commands();
  }

  respondToPermission(requestId: string, decision: PermissionDecision): void {
    for (const session of this.sessions.values()) session.respondToPermission(requestId, decision);
  }

  /** Ids are unique across sessions, so the right runtime claims the answer. */
  answerExtensionUi(answer: ExtensionUiAnswer): void {
    for (const session of this.sessions.values()) session.answerExtensionUi(answer);
  }

  setEditorText(text: string, sessionId?: string): void {
    const session = sessionId ? this.sessions.get(sessionId) : this.activeSession();
    session?.setEditorText(text);
  }

  publish(sessionId: string | null, event: AgentEvent): void {
    this.hub.publish(sessionId, event);
  }
}

/**
 * "Auth redesign" forked twice should not produce "Fork of fork of Auth
 * redesign" — the number is the useful part, and the original name is what the
 * session list is scanned for.
 */
function forkTitle(title: string): string {
  const match = /^(.*) \((\d+)\)$/.exec(title);
  if (match?.[1]) return `${match[1]} (${Number(match[2]) + 1})`;
  return `${title} (2)`;
}
