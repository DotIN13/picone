import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Workspace, WorkspaceFile, WorkspaceRoot } from "@picone/protocol";
import { expandPath } from "../util/paths.ts";
import { validateWorkspaceFile } from "./schema.ts";

export class WorkspaceLoadError extends Error {
  constructor(
    message: string,
    readonly errors: string[],
  ) {
    super(message);
    this.name = "WorkspaceLoadError";
  }
}

/**
 * workspace.json → validate → resolved Workspace (DESIGN §3).
 * Directories that do not exist are reported as diagnostics rather than
 * failing the load, so a shared workspace file still opens on another machine.
 */
export function loadWorkspace(filePath: string): Workspace {
  const abs = expandPath(filePath);

  let text: string;
  try {
    text = readFileSync(abs, "utf8");
  } catch (err) {
    throw new WorkspaceLoadError(`Cannot read workspace file: ${abs}`, [(err as Error).message]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new WorkspaceLoadError(`Workspace file is not valid JSON: ${abs}`, [(err as Error).message]);
  }

  const { file, errors, warnings } = validateWorkspaceFile(raw);
  if (!file) throw new WorkspaceLoadError(`Workspace file is invalid: ${abs}`, errors);

  const workspaceDir = path.dirname(abs);
  const diagnostics = [...warnings];
  const seen = new Set<string>();
  const roots: WorkspaceRoot[] = [];

  /*
   * One working directory, then everything open beside it (§3).
   *
   * `directories` is the flat list this replaced: its first entry is read as
   * the cwd and the rest as context, which is what it already meant in
   * practice — the runtime picked the first existing one to work in.
   *
   * Deduplication is by exact path only. A context directory *inside* the cwd
   * is a different path and is kept: nesting is allowed, and pulling a
   * subdirectory out to the top of the sidebar is a large part of the point.
   */
  const legacy = file.directories ?? [];
  const cwdEntry = file.cwd ?? legacy[0];
  const contextEntries = [...(file.context ?? []), ...(file.cwd ? legacy : legacy.slice(1))];

  const add = (dir: string, kind: "cwd" | "context") => {
    const resolved = expandPath(dir, workspaceDir);
    if (seen.has(resolved)) {
      diagnostics.push(`Duplicate directory ignored: ${dir}`);
      return;
    }
    seen.add(resolved);

    let exists = false;
    try {
      exists = statSync(resolved).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) diagnostics.push(`Directory does not exist: ${resolved}`);

    roots.push({
      name: path.basename(resolved) || resolved,
      path: resolved,
      exists,
      kind,
      writable: true,
    });
  };

  if (cwdEntry) add(cwdEntry, "cwd");
  for (const dir of contextEntries) add(dir, "context");

  const cwd = roots.find((root) => root.kind === "cwd")?.path ?? null;

  for (const skillPath of file.skillPaths ?? []) {
    const resolved = expandPath(skillPath, workspaceDir);
    try {
      statSync(resolved);
    } catch {
      diagnostics.push(`Skill directory does not exist: ${resolved}`);
    }
  }

  // `memory` is filled by the app, which is the only thing that can see the
  // global list this workspace's entries merge with (§50).
  return { path: abs, file, roots, cwd, memory: [], diagnostics };
}

/** Stable id for a workspace — the absolute file path is portable enough. */
export function workspaceId(ws: Workspace): string {
  return ws.path;
}

/**
 * The compact workspace description injected at session creation (DESIGN §6).
 * Pi owns everything else about context.
 */
export function workspaceContext(ws: Workspace): string {
  const lines: string[] = [];
  lines.push(`You are operating in the workspace "${ws.file.name}".`);

  /*
   * Paths and one line of purpose, and nothing else (DESIGN §3).
   *
   * The directories are disclosed as pointers rather than described: what is
   * inside them is discoverable with the tools, and spending context on a
   * summary that will be stale by the second turn buys nothing. Memory
   * directories are deliberately absent — they are readable roots, but listing
   * them here sends the agent hunting for source files in them, so they get
   * their own context file (§50).
   */
  const cwd = ws.roots.find((root) => root.kind === "cwd");
  const context = ws.roots.filter((root) => root.kind === "context");

  if (cwd) {
    lines.push("");
    lines.push(`Working directory: ${cwd.path}${cwd.exists ? "" : " (missing)"}`);
  }

  if (context.length > 0) {
    lines.push("");
    lines.push("Also open, and writable, alongside it:");
    lines.push("");
    for (const root of context) lines.push(`- ${root.path}${root.exists ? "" : " (missing)"}`);
    // Worth saying, because a listing of the cwd will not reveal it and a
    // listing of a nested one looks like a duplicate.
    lines.push("");
    lines.push("Some of these may sit inside the working directory, or contain it. That is intended.");
  }

  if (ws.file.instructions?.length) {
    lines.push("");
    lines.push("Workspace instructions:");
    lines.push("");
    for (const instruction of ws.file.instructions) lines.push(`- ${instruction}`);
  }

  lines.push("");
  lines.push("Use ordinary absolute paths. Work across any of these directories as needed.");
  lines.push("");
  lines.push(
    "The human reviews your work in a web UI and can leave comments anchored to selected text in a file. " +
      'When a comment arrives, treat it as direct feedback on that text. After you act on it, call `mark_comment_addressed` with the comment id.',
  );

  return lines.join("\n");
}

export function resolveSkillPaths(ws: WorkspaceFile, workspaceFilePath: string): string[] {
  const base = path.dirname(workspaceFilePath);
  return (ws.skillPaths ?? []).map((skillPath) => expandPath(skillPath, base));
}
