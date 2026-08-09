import { DatabaseSync } from "node:sqlite";
import type { ChatItem, CommentStatus, FileComment, RecentWorkspace, SessionSummary } from "@picone/protocol";
import { DB_PATH, ensureDataDir } from "./config.ts";

/**
 * Runtime state only (DESIGN §37). Workspace configuration is never mirrored here —
 * the workspace JSON file stays the single source of truth.
 */
let db: DatabaseSync;

export function openDb(): DatabaseSync {
  if (db) return db;
  ensureDataDir();
  db = new DatabaseSync(DB_PATH);
  db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS sessions (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      title         TEXT NOT NULL,
      session_file  TEXT,
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          TEXT PRIMARY KEY,
      session_id  TEXT NOT NULL,
      seq         INTEGER NOT NULL,
      payload     TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_session_seq ON messages(session_id, seq);

    CREATE TABLE IF NOT EXISTS comments (
      id            TEXT PRIMARY KEY,
      workspace_id  TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      path          TEXT NOT NULL,
      matcher       TEXT NOT NULL,
      line_start    INTEGER,
      line_end      INTEGER,
      body          TEXT NOT NULL,
      status        TEXT NOT NULL,
      created_at    TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS comments_workspace_path ON comments(workspace_id, path);

    CREATE TABLE IF NOT EXISTS recent_workspaces (
      path       TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      opened_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ui_state (
      key    TEXT PRIMARY KEY,
      value  TEXT NOT NULL
    );
  `);
  return db;
}

// --- sessions --------------------------------------------------------------

export function insertSession(workspaceId: string, s: SessionSummary): void {
  openDb()
    .prepare(
      `INSERT INTO sessions (id, workspace_id, title, session_file, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(s.id, workspaceId, s.title, s.sessionFile ?? null, s.createdAt, s.updatedAt);
}

export function updateSession(id: string, patch: { title?: string; sessionFile?: string }): void {
  const now = new Date().toISOString();
  if (patch.title !== undefined) {
    openDb().prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`).run(patch.title, now, id);
  }
  if (patch.sessionFile !== undefined) {
    openDb().prepare(`UPDATE sessions SET session_file = ?, updated_at = ? WHERE id = ?`).run(patch.sessionFile, now, id);
  }
}

export function touchSession(id: string): void {
  openDb().prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(new Date().toISOString(), id);
}

export function listSessions(workspaceId: string): SessionSummary[] {
  const rows = openDb()
    .prepare(
      `SELECT id, title, session_file, created_at, updated_at
       FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: String(r.id),
    title: String(r.title),
    sessionFile: r.session_file == null ? undefined : String(r.session_file),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  }));
}

export function deleteSession(id: string): void {
  openDb().prepare(`DELETE FROM messages WHERE session_id = ?`).run(id);
  openDb().prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

// --- transcript ------------------------------------------------------------

export function appendMessage(sessionId: string, seq: number, item: ChatItem): void {
  openDb()
    .prepare(
      `INSERT INTO messages (id, session_id, seq, payload) VALUES (?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, seq = excluded.seq`,
    )
    .run(`${sessionId}:${item.id}`, sessionId, seq, JSON.stringify(item));
}

export function loadTranscript(sessionId: string): ChatItem[] {
  const rows = openDb()
    .prepare(`SELECT payload FROM messages WHERE session_id = ? ORDER BY seq ASC`)
    .all(sessionId) as Array<Record<string, unknown>>;
  return rows.map((r) => JSON.parse(String(r.payload)) as ChatItem);
}

// --- comments --------------------------------------------------------------

function rowToComment(r: Record<string, unknown>): FileComment {
  return {
    id: String(r.id),
    workspaceId: String(r.workspace_id),
    sessionId: String(r.session_id),
    path: String(r.path),
    matcher: String(r.matcher),
    lineStart: r.line_start == null ? undefined : Number(r.line_start),
    lineEnd: r.line_end == null ? undefined : Number(r.line_end),
    body: String(r.body),
    status: String(r.status) as CommentStatus,
    createdAt: String(r.created_at),
  };
}

export function insertComment(c: FileComment): void {
  openDb()
    .prepare(
      `INSERT INTO comments (id, workspace_id, session_id, path, matcher, line_start, line_end, body, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.id,
      c.workspaceId,
      c.sessionId,
      c.path,
      c.matcher,
      c.lineStart ?? null,
      c.lineEnd ?? null,
      c.body,
      c.status,
      c.createdAt,
    );
}

export function setCommentStatus(id: string, status: CommentStatus): FileComment | null {
  openDb().prepare(`UPDATE comments SET status = ? WHERE id = ?`).run(status, id);
  return getComment(id);
}

export function getComment(id: string): FileComment | null {
  const row = openDb().prepare(`SELECT * FROM comments WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToComment(row) : null;
}

export function listCommentsForWorkspace(workspaceId: string): FileComment[] {
  const rows = openDb()
    .prepare(`SELECT * FROM comments WHERE workspace_id = ? ORDER BY created_at ASC`)
    .all(workspaceId) as Array<Record<string, unknown>>;
  return rows.map(rowToComment);
}

// --- recent workspaces -----------------------------------------------------

export function rememberWorkspace(path: string, name: string): void {
  openDb()
    .prepare(
      `INSERT INTO recent_workspaces (path, name, opened_at) VALUES (?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET name = excluded.name, opened_at = excluded.opened_at`,
    )
    .run(path, name, new Date().toISOString());
}

export function listRecentWorkspaces(limit = 10): RecentWorkspace[] {
  const rows = openDb()
    .prepare(`SELECT path, name, opened_at FROM recent_workspaces ORDER BY opened_at DESC LIMIT ?`)
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map((r) => ({ path: String(r.path), name: String(r.name), openedAt: String(r.opened_at) }));
}

export function forgetWorkspace(path: string): void {
  openDb().prepare(`DELETE FROM recent_workspaces WHERE path = ?`).run(path);
}

// --- ui state --------------------------------------------------------------

export function setUiState(key: string, value: unknown): void {
  openDb()
    .prepare(`INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
    .run(key, JSON.stringify(value));
}

export function getUiState<T>(key: string): T | null {
  const row = openDb().prepare(`SELECT value FROM ui_state WHERE key = ?`).get(key) as
    | Record<string, unknown>
    | undefined;
  if (!row) return null;
  try {
    return JSON.parse(String(row.value)) as T;
  } catch {
    return null;
  }
}
