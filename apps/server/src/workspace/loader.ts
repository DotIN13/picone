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

  for (const dir of file.directories) {
    const resolved = expandPath(dir, workspaceDir);
    if (seen.has(resolved)) {
      diagnostics.push(`Duplicate directory ignored: ${dir}`);
      continue;
    }
    seen.add(resolved);

    let exists = false;
    try {
      exists = statSync(resolved).isDirectory();
    } catch {
      exists = false;
    }
    if (!exists) diagnostics.push(`Directory does not exist: ${resolved}`);

    roots.push({ name: path.basename(resolved) || resolved, path: resolved, exists });
  }

  for (const skill of file.skills ?? []) {
    const resolved = expandPath(skill.path, workspaceDir);
    try {
      statSync(resolved);
    } catch {
      diagnostics.push(`Skill "${skill.name}" path does not exist: ${resolved}`);
    }
  }

  return { path: abs, file, roots, diagnostics };
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
  lines.push("");
  lines.push("The workspace contains these directories:");
  lines.push("");
  for (const root of ws.roots) lines.push(`- ${root.path}${root.exists ? "" : " (missing)"}`);

  if (ws.file.instructions?.length) {
    lines.push("");
    lines.push("Workspace instructions:");
    lines.push("");
    for (const instruction of ws.file.instructions) lines.push(`- ${instruction}`);
  }

  lines.push("");
  lines.push(
    "Use ordinary absolute paths. Work across any of these directories as needed; there is no single working directory that matters.",
  );
  lines.push("");
  lines.push(
    "The human reviews your work in a web UI and can leave comments anchored to selected text in a file. " +
      'When a comment arrives, treat it as direct feedback on that text. After you act on it, call `mark_comment_addressed` with the comment id.',
  );

  return lines.join("\n");
}

export function resolveSkillPaths(ws: WorkspaceFile, workspaceFilePath: string): string[] {
  const base = path.dirname(workspaceFilePath);
  return (ws.skills ?? []).map((s) => expandPath(s.path, base));
}
