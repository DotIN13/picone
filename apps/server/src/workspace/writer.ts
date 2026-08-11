import { writeFileSync } from "node:fs";
import type { ResolvedMemoryDir, Workspace, WorkspaceFile } from "@picone/protocol";
import { loadWorkspace } from "./loader.ts";
import { validateWorkspaceFile } from "./schema.ts";

/**
 * Workspace edits go back to the JSON file (DESIGN §34) — it stays the source of
 * truth, so the file remains readable and diffable after UI edits.
 */
export function writeWorkspaceFile(filePath: string, file: WorkspaceFile): Workspace {
  const { file: validated, errors } = validateWorkspaceFile(file);
  if (!validated) throw new Error(`Refusing to write invalid workspace file: ${errors.join("; ")}`);

  writeFileSync(filePath, `${JSON.stringify(stripUndefined(validated), null, 2)}\n`, "utf8");
  return loadWorkspace(filePath);
}

/** Keep the written JSON clean: no `"skills": null` noise from optional fields. */
function stripUndefined<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stripUndefined) as unknown as T;
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      out[k] = stripUndefined(v);
    }
    return out as T;
  }
  return value;
}

/**
 * What a session has already been told about its workspace.
 *
 * The file *and* the resolved memory list, because memory merges two sources —
 * the workspace file and the global settings — so the file alone cannot say
 * whether a directory became readable (§50).
 */
export interface WorkspaceSnapshot {
  file: WorkspaceFile;
  memory: ResolvedMemoryDir[];
}

export function snapshotOf(workspace: Workspace): WorkspaceSnapshot {
  return { file: workspace.file, memory: workspace.memory };
}

/**
 * Describes a config change in one short paragraph so the running session can be
 * told what happened without rebuilding its context (DESIGN §34).
 */
export function describeWorkspaceChange(
  beforeSnapshot: WorkspaceSnapshot,
  afterSnapshot: WorkspaceSnapshot,
): string | null {
  const before = beforeSnapshot.file;
  const after = afterSnapshot.file;
  const parts: string[] = [];

  // Every directory the workspace opens, whichever field it came from — what
  // matters to the agent is that one appeared, not which list holds it.
  const opened = (file: WorkspaceFile) => [
    ...(file.cwd ? [file.cwd] : []),
    ...(file.context ?? []),
    ...(file.directories ?? []),
  ];
  const beforeDirs = opened(before);
  const afterDirs = opened(after);

  if (before.cwd !== after.cwd && after.cwd) {
    parts.push(`The working directory is now ${after.cwd}.`);
  }

  const added = afterDirs.filter((d) => !beforeDirs.includes(d));
  const removed = beforeDirs.filter((d) => !afterDirs.includes(d));
  if (added.length) parts.push(`The following directories were added:\n\n${added.map((d) => `- ${d}`).join("\n")}`);
  if (removed.length)
    parts.push(`The following directories were removed:\n\n${removed.map((d) => `- ${d}`).join("\n")}`);

  const permKeys = ["files", "shell", "git"] as const;
  const permChanges = permKeys
    .filter((k) => (before.permissions?.[k] ?? null) !== (after.permissions?.[k] ?? null))
    .map((k) => `${k}: ${after.permissions?.[k] ?? "default"}`);
  if (permChanges.length) parts.push(`Permissions were updated:\n\n${permChanges.join("\n")}`);

  const beforeInstructions = (before.instructions ?? []).join("\n");
  const afterInstructions = (after.instructions ?? []).join("\n");
  if (beforeInstructions !== afterInstructions) {
    parts.push(
      after.instructions?.length
        ? `Workspace instructions are now:\n\n${after.instructions.map((i) => `- ${i}`).join("\n")}`
        : "Workspace instructions were cleared.",
    );
  }

  const beforeMcp = Object.entries(before.mcp ?? {})
    .filter(([, c]) => c.enabled !== false)
    .map(([n]) => n);
  const afterMcp = Object.entries(after.mcp ?? {})
    .filter(([, c]) => c.enabled !== false)
    .map(([n]) => n);
  const mcpAdded = afterMcp.filter((n) => !beforeMcp.includes(n));
  const mcpRemoved = beforeMcp.filter((n) => !afterMcp.includes(n));
  if (mcpAdded.length) parts.push(`MCP servers enabled: ${mcpAdded.join(", ")}`);
  if (mcpRemoved.length) parts.push(`MCP servers disabled: ${mcpRemoved.join(", ")}`);

  const beforePaths = (before.skillPaths ?? []).join(",");
  const afterPaths = (after.skillPaths ?? []).join(",");
  if (beforePaths !== afterPaths) parts.push(`Skill directories are now: ${afterPaths || "(none)"}`);

  // Resources are loaded when a session is built, so say plainly that this one
  // is not affected — otherwise the agent would look for a skill it still has.
  for (const kind of ["skills", "prompts", "extensions"] as const) {
    const wasOff = (name: string) => before[kind]?.[name]?.enabled === false;
    const isOff = (name: string) => after[kind]?.[name]?.enabled === false;
    const names = new Set([...Object.keys(before[kind] ?? {}), ...Object.keys(after[kind] ?? {})]);

    const turnedOff = [...names].filter((n) => isOff(n) && !wasOff(n));
    const turnedOn = [...names].filter((n) => wasOff(n) && !isOff(n));
    if (turnedOff.length) parts.push(`${kind} switched off for new sessions: ${turnedOff.join(", ")}`);
    if (turnedOn.length) parts.push(`${kind} switched back on for new sessions: ${turnedOn.join(", ")}`);
  }

  /*
   * Memory (§50), which the file alone cannot describe: an entry may come from
   * the global list, and what matters is whether the directory is *readable*
   * now — enabled and actually on disk — not which of the two lists names it.
   *
   * Keyed by name and compared by path, so a directory that was repointed
   * somewhere else reads as one arriving and one leaving rather than as no
   * change at all.
   */
  const readable = (dirs: ResolvedMemoryDir[]) =>
    new Map(dirs.filter((dir) => dir.enabled && dir.exists).map((dir) => [dir.name, dir.path]));
  const beforeMemory = readable(beforeSnapshot.memory);
  const afterMemory = readable(afterSnapshot.memory);

  const memoryAdded = [...afterMemory].filter(([name, path]) => beforeMemory.get(name) !== path);
  const memoryGone = [...beforeMemory].filter(([name, path]) => afterMemory.get(name) !== path);

  if (memoryAdded.length) {
    const list = memoryAdded.map(([name, path]) => `- ${name}: ${path}`).join("\n");
    parts.push(
      `Memory directories you can now read:\n\n${list}\n\n` +
        "A memory store's own instructions are loaded when a session starts, so for this session, look inside before relying on it.",
    );
  }
  if (memoryGone.length) {
    const list = memoryGone.map(([name, path]) => `- ${name}: ${path}`).join("\n");
    parts.push(`Memory directories no longer available:\n\n${list}`);
  }

  if (!parts.length) return null;
  return `Workspace update:\n\n${parts.join("\n\n")}`;
}

/**
 * A pending update in front of what the human actually said (DESIGN §34).
 *
 * A rule rather than a format string, because the agent has to be able to tell
 * the two apart: the update is Picone speaking about the workspace, the text
 * below the divider is the person. Without the divider a settings paragraph
 * reads as something the human typed and gets answered as if it were a request.
 */
export function withWorkspaceUpdate(update: string | null, text: string): string {
  const BLANK_LINE = "\n\n";
  return update ? [update, "---", text].join(BLANK_LINE) : text;
}
