import { DatabaseSync } from "node:sqlite";
import type { ChatItem, CommentStatus, FileComment, RecentWorkspace, SessionSummary } from "@picone/protocol";
import { DB_PATH, ensureDataDir } from "./config.ts";

/**
 * Runtime state (DESIGN §37). The workspace JSON file stays the single source of
 * truth for *configuration* — what is kept here is the resolved result of it, a
 * record of what each workspace looked like once the global settings were
 * merged in, so a session can be told what changed since it last heard (§34).
 * Nothing here is read to decide behaviour; the file is reloaded for that.
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
      updated_at    TEXT NOT NULL,
      forked_from   TEXT
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
  // `CREATE TABLE IF NOT EXISTS` leaves an existing table alone, so a column
  // added later has to be added by hand. Failing means it is already there.
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN forked_from TEXT`);
  } catch {
    /* already migrated */
  }
  try {
    db.exec(`ALTER TABLE sessions ADD COLUMN workspace_seen TEXT`);
  } catch {
    /* already migrated */
  }

  return db;
}

// --- sessions --------------------------------------------------------------

export function insertSession(workspaceId: string, s: SessionSummary): void {
  openDb()
    .prepare(
      `INSERT INTO sessions (id, workspace_id, title, session_file, created_at, updated_at, forked_from)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(s.id, workspaceId, s.title, s.sessionFile ?? null, s.createdAt, s.updatedAt, s.forkedFrom ?? null);
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

/**
 * Sessions for the list, newest conversation first (DESIGN §27).
 *
 * "Newest" means the last thing said in it, not the last time it was opened.
 * Ordering by `updated_at` put whichever session you clicked at the top, which
 * reshuffles the list as you read it and buries a conversation you were in the
 * middle of the moment you glance at another one.
 *
 * A session where nothing has been said falls back to when it was created, so a
 * new empty session still appears at the top where it was just made.
 */
export function listSessions(workspaceId: string): SessionSummary[] {
  const rows = openDb()
    .prepare(
      `SELECT id, title, session_file, created_at, updated_at, forked_from
       FROM sessions WHERE workspace_id = ?`,
    )
    .all(workspaceId) as Array<Record<string, unknown>>;

  return rows
    .map((r) => {
      const said = lastSaid(String(r.id));
      return {
        id: String(r.id),
        title: String(r.title),
        sessionFile: r.session_file == null ? undefined : String(r.session_file),
        createdAt: String(r.created_at),
        updatedAt: said?.at ?? String(r.created_at),
        forkedFrom: r.forked_from == null ? undefined : String(r.forked_from),
        excerpt: said?.text,
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The session to reopen when the workspace opens — the one that was last
 * *opened*, which is a different question from the one the list answers. You
 * want to come back to where you were, even if another session has newer
 * messages in it from a background run.
 */
export function lastOpenedSession(workspaceId: string): string | undefined {
  const row = openDb()
    .prepare(`SELECT id FROM sessions WHERE workspace_id = ? ORDER BY updated_at DESC LIMIT 1`)
    .get(workspaceId) as Record<string, unknown> | undefined;
  return row ? String(row.id) : undefined;
}

/**
 * The newest thing anybody actually said, and when — the session list shows one
 * line of it and orders by its timestamp (DESIGN §27).
 *
 * Only user and assistant messages. A transcript ends in machinery far more
 * often than in conversation — a model switch, a rewind notice, an API error,
 * a tool call — and a list of rows reading "Model switched to …" tells you
 * nothing about which conversation each one was.
 *
 * The newest of the two rather than the newest *user* message: what a session
 * is about right now is usually the answer, not the question. Its timestamp is
 * also what the list sorts by, so the row's text and its time always describe
 * the same moment.
 */
function lastSaid(sessionId: string): { text: string; at: string } | undefined {
  // Narrow in SQL so this stays one small read per session, then confirm by
  // parsing — a message whose own text contains `"kind":"user"` would match the
  // pattern, and a coding transcript is exactly where that happens.
  const rows = openDb()
    .prepare(
      `SELECT payload FROM messages
       WHERE session_id = ?
         AND (payload LIKE '%"kind":"user"%' OR payload LIKE '%"kind":"assistant"%')
       ORDER BY seq DESC LIMIT 12`,
    )
    .all(sessionId) as Array<Record<string, unknown>>;

  for (const row of rows) {
    let item: ChatItem;
    try {
      item = JSON.parse(String(row.payload)) as ChatItem;
    } catch {
      continue;
    }
    if (item.kind !== "user" && item.kind !== "assistant") continue;

    // An assistant turn that was all thinking, or all tool calls, has no text.
    const flat = item.text.replace(/\s+/g, " ").trim();
    if (!flat) continue;

    return { text: flat.length > 120 ? `${flat.slice(0, 119)}…` : flat, at: item.at };
  }

  return undefined;
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

/**
 * Drop everything from `seq` onwards (DESIGN §53).
 *
 * Used when a session is rewound: our transcript is the rendered conversation,
 * not Pi's tree, so the branch just left stops being part of it. Nothing is
 * lost that matters — Pi's session file keeps the whole tree, and this table is
 * only what the browser draws.
 */
export function truncateTranscript(sessionId: string, seq: number): void {
  openDb().prepare(`DELETE FROM messages WHERE session_id = ? AND seq >= ?`).run(sessionId, seq);
}

/**
 * A page of transcript, newest first in the file but returned in reading order
 * (DESIGN §14).
 *
 * Sessions are append-only and long-lived, so a year-old one should not have to
 * be read whole to be opened. `seq` is the cursor: rows are dense and ordered,
 * and the first one loaded says where the page begins.
 */
export interface TranscriptPage {
  items: ChatItem[];
  /** `seq` of the first item, or the next free seq when the page is empty. */
  firstSeq: number;
  /** There is history before `firstSeq`. */
  hasMore: boolean;
}

function parse(rows: Array<Record<string, unknown>>): Array<{ seq: number; item: ChatItem }> {
  const out: Array<{ seq: number; item: ChatItem }> = [];
  for (const row of rows) {
    try {
      out.push({ seq: Number(row.seq), item: JSON.parse(String(row.payload)) as ChatItem });
    } catch {
      // A row we cannot read is a row we skip; one bad payload must not stop a
      // session from opening.
    }
  }
  return out;
}

/** The end of the transcript — what a session opens showing. */
export function loadTranscriptTail(sessionId: string, limit: number): TranscriptPage {
  const rows = openDb()
    .prepare(`SELECT seq, payload FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?`)
    .all(sessionId, limit) as Array<Record<string, unknown>>;

  const page = parse(rows).reverse();
  const next = nextSeq(sessionId);
  const firstSeq = page[0]?.seq ?? next;
  return { items: page.map((p) => p.item), firstSeq, hasMore: firstSeq > 0 };
}

/** The page before `seq`, for scrolling back through a long session. */
export function loadTranscriptBefore(sessionId: string, seq: number, limit: number): TranscriptPage {
  const rows = openDb()
    .prepare(`SELECT seq, payload FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?`)
    .all(sessionId, seq, limit) as Array<Record<string, unknown>>;

  const page = parse(rows).reverse();
  const firstSeq = page[0]?.seq ?? seq;
  return { items: page.map((p) => p.item), firstSeq, hasMore: firstSeq > 0 };
}

/** Where a message's row sits, so the browser can ask for what precedes it. */
export function seqOfMessage(sessionId: string, itemId: string): number | null {
  const row = openDb()
    .prepare(`SELECT seq FROM messages WHERE id = ?`)
    .get(`${sessionId}:${itemId}`) as Record<string, unknown> | undefined;
  return row ? Number(row.seq) : null;
}

/**
 * The next free sequence number. Read from the table rather than counted from
 * what is in memory, which is now only the tail.
 */
export function nextSeq(sessionId: string): number {
  const row = openDb()
    .prepare(`SELECT MAX(seq) AS top FROM messages WHERE session_id = ?`)
    .get(sessionId) as Record<string, unknown> | undefined;
  return row?.top == null ? 0 : Number(row.top) + 1;
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

// --- what a session has been told about its workspace (DESIGN §34) ----------

/**
 * The resolved workspace a session last heard about, as stored JSON.
 *
 * Per session and persisted, so the comparison survives the session being
 * evicted, the server restarting, or the workspace being edited while nothing
 * was running. Null means the session has never been told — a new session,
 * whose description went in with its context.
 */
export function seenWorkspace(sessionId: string): string | null {
  const row = openDb().prepare(`SELECT workspace_seen AS seen FROM sessions WHERE id = ?`).get(sessionId) as
    | { seen: string | null }
    | undefined;
  return row?.seen ?? null;
}

export function setSeenWorkspace(sessionId: string, resolved: string): void {
  openDb().prepare(`UPDATE sessions SET workspace_seen = ? WHERE id = ?`).run(resolved, sessionId);
}
