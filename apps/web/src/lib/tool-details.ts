/**
 * Reading the structured result a tool attached to its output (DESIGN §56).
 *
 * Pi lets a tool return `details` beside its text, and extensions use it to say
 * what they did in a form other than prose. The shapes are not ours and are not
 * declared anywhere we can import, so everything here is a *guess that checks
 * itself*: recognise a shape, or fall back to showing the JSON.
 */

export type TodoStatus = "pending" | "in_progress" | "completed" | "deleted";

export interface TodoTask {
  id: number;
  subject: string;
  status: TodoStatus;
  description?: string;
  blockedBy?: number[];
}

export interface TodoDetails {
  tasks: TodoTask[];
  /** What the call did, when it says — "create", "update", and so on. */
  action?: string;
  error?: string;
}

const STATUSES = new Set<TodoStatus>(["pending", "in_progress", "completed", "deleted"]);

function isTask(value: unknown): value is TodoTask {
  if (!value || typeof value !== "object") return false;
  const task = value as Record<string, unknown>;
  return (
    typeof task.id === "number" &&
    typeof task.subject === "string" &&
    typeof task.status === "string" &&
    STATUSES.has(task.status as TodoStatus)
  );
}

/**
 * A task list, if that is what this is.
 *
 * Matched on shape rather than on the tool's name: `todo` is what the extension
 * we know about calls itself, but the shape is the actual contract and another
 * extension emitting the same thing should render the same way. Every task must
 * check out — a half-recognised list would render half its rows.
 */
export function asTodoDetails(details: unknown): TodoDetails | null {
  if (!details || typeof details !== "object") return null;
  const record = details as Record<string, unknown>;
  if (!Array.isArray(record.tasks) || record.tasks.length === 0) return null;
  if (!record.tasks.every(isTask)) return null;

  return {
    tasks: record.tasks as TodoTask[],
    action: typeof record.action === "string" ? record.action : undefined,
    error: typeof record.error === "string" ? record.error : undefined,
  };
}

/** Tasks worth showing, and the count that goes beside them. */
export function todoProgress(tasks: TodoTask[]): { visible: TodoTask[]; done: number; total: number } {
  // A deleted task is a task that is not there; it is in the list only so the
  // model can see it was removed.
  const visible = tasks.filter((task) => task.status !== "deleted");
  return {
    visible,
    done: visible.filter((task) => task.status === "completed").length,
    total: visible.length,
  };
}

/**
 * Anything else, by shape (DESIGN §56).
 *
 * The alternative to a renderer per extension. There is no schema for `details`
 * — Pi lets a tool return whatever it likes — but the *shapes* repeat, and a
 * shape is enough to lay something out: a list of records is a table whatever
 * the records are about, and a flat object is a list of fields. So the common
 * shapes are drawn and only the genuinely irregular falls back to JSON.
 *
 * This is deliberately not clever. It reads one level down and no further:
 * nesting past that is structure we would be guessing at, and a wrong guess is
 * worse than the JSON, which is at least honestly shapeless.
 */

export type DetailNode =
  | { kind: "field"; key: string; value: string }
  | { kind: "list"; key: string; items: string[] }
  | { kind: "table"; key: string; columns: string[]; rows: string[][] }
  | { kind: "json"; key: string; text: string };

/** Beyond these, a table stops being readable and becomes a data dump. */
const MAX_ROWS = 50;
const MAX_COLUMNS = 8;

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const show = (value: unknown): string => (value === null || value === undefined ? "" : String(value));

/**
 * The columns of a list of records, in first-seen order.
 *
 * Every row need not carry every column — a missing field renders empty, which
 * is what a table is for. What disqualifies the shape is a row that is not a
 * record at all, or a value inside one that is not scalar.
 */
function tableColumns(rows: Record<string, unknown>[]): string[] | null {
  const columns: string[] = [];
  for (const row of rows) {
    for (const [key, value] of Object.entries(row)) {
      if (!isScalar(value) && value !== null && value !== undefined) return null;
      if (!columns.includes(key)) columns.push(key);
      if (columns.length > MAX_COLUMNS) return null;
    }
  }
  return columns.length > 0 ? columns : null;
}

function nodeFor(key: string, value: unknown): DetailNode | null {
  if (value === null || value === undefined || value === "") return null;
  if (isScalar(value)) return { kind: "field", key, value: show(value) };

  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every(isScalar)) return { kind: "list", key, items: value.map(show) };

    const records = value.filter((row): row is Record<string, unknown> => Boolean(row) && typeof row === "object" && !Array.isArray(row));
    if (records.length === value.length && value.length <= MAX_ROWS) {
      const columns = tableColumns(records);
      if (columns) {
        return { kind: "table", key, columns, rows: records.map((row) => columns.map((c) => show(row[c]))) };
      }
    }
  }

  // A plain object of scalars is a table of one row, which reads better as one.
  if (typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 0 && entries.every(([, v]) => isScalar(v))) {
      return { kind: "table", key, columns: entries.map(([k]) => k), rows: [entries.map(([, v]) => show(v))] };
    }
  }

  try {
    return { kind: "json", key, text: JSON.stringify(value, null, 2) };
  } catch {
    return null;
  }
}

const RENDERED_ELSEWHERE = new Set(["patch", "tasks"]);

/** Everything in `details` that is not already drawn, as nodes to lay out. */
export function describeDetails(details: unknown): DetailNode[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    const single = nodeFor("", details);
    return single ? [single] : [];
  }

  const nodes: DetailNode[] = [];
  for (const [key, value] of Object.entries(details as Record<string, unknown>)) {
    if (RENDERED_ELSEWHERE.has(key)) continue;
    const node = nodeFor(key, value);
    if (node) nodes.push(node);
  }
  return nodes;
}
