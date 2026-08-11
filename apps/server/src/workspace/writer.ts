import { writeFileSync } from "node:fs";
import type { ResolvedMemoryDir, Workspace, WorkspaceFile } from "@picone/protocol";
import { loadWorkspace } from "./loader.ts";
import { resolvedPermissions, validateWorkspaceFile } from "./schema.ts";

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
 * What a session has already been told about its workspace (DESIGN §34).
 *
 * The *resolved* configuration, not the file. Three of these fields cannot be
 * read off `workspace.json` at all — memory, MCP servers and skill directories
 * each merge the workspace's entries with the global settings — so a session
 * comparing against the file would never notice a globally-added one arriving.
 * The rest are resolved for a plainer reason: the file says `"."` and the agent
 * needs the directory that resolves to, and permissions have defaults the file
 * leaves unstated.
 */
export interface WorkspaceSnapshot {
  name: string;
  cwd: string | null;
  /** Absolute, with what each one is for. Memory is listed separately. */
  directories: Array<{ path: string; kind: "cwd" | "context"; exists: boolean }>;
  memory: ResolvedMemoryDir[];
  mcpServers: Array<{ name: string; enabled: boolean }>;
  skillPaths: string[];
  permissions: Required<NonNullable<WorkspaceFile["permissions"]>>;
  instructions: string[];
  /** Resources switched off for new sessions, by kind. */
  disabled: Record<"skills" | "prompts" | "extensions", string[]>;
}

const offNames = (resources: Record<string, { enabled?: boolean }> | undefined): string[] =>
  Object.entries(resources ?? {})
    .filter(([, entry]) => entry.enabled === false)
    .map(([name]) => name)
    .sort();

export function snapshotOf(workspace: Workspace): WorkspaceSnapshot {
  const file = workspace.file;
  return {
    name: file.name,
    cwd: workspace.cwd,
    directories: workspace.roots
      .filter((root) => root.kind !== "memory")
      .map((root) => ({ path: root.path, kind: root.kind as "cwd" | "context", exists: root.exists })),
    memory: workspace.memory,
    mcpServers: workspace.mcpServers.map(({ name, enabled }) => ({ name, enabled })),
    skillPaths: workspace.skillPaths,
    permissions: resolvedPermissions(file),
    instructions: file.instructions ?? [],
    disabled: {
      skills: offNames(file.skills),
      prompts: offNames(file.prompts),
      extensions: offNames(file.extensions),
    },
  };
}

/**
 * Is this a snapshot this version can compare against?
 *
 * What is stored was written by whatever version last ran, and the shape has
 * changed once already. A record that does not match is treated as no record at
 * all — the session starts level, which loses one update at worst, where
 * comparing against a half-missing shape would throw on the next message.
 */
export function isWorkspaceSnapshot(value: unknown): value is WorkspaceSnapshot {
  if (!value || typeof value !== "object") return false;
  const snapshot = value as Partial<WorkspaceSnapshot>;
  return (
    Array.isArray(snapshot.directories) &&
    Array.isArray(snapshot.memory) &&
    Array.isArray(snapshot.mcpServers) &&
    Array.isArray(snapshot.skillPaths) &&
    Array.isArray(snapshot.instructions) &&
    typeof snapshot.permissions === "object" &&
    snapshot.permissions !== null &&
    typeof snapshot.disabled === "object" &&
    snapshot.disabled !== null
  );
}

/**
 * Describes a config change in one short paragraph so the running session can be
 * told what happened without rebuilding its context (DESIGN §34).
 */
export function describeWorkspaceChange(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string | null {
  const parts: string[] = [];
  const bullets = (items: string[]) => items.map((item) => `- ${item}`).join("\n");

  if (before.name !== after.name) parts.push(`The workspace is now called "${after.name}".`);

  /*
   * Directories, as absolute paths rather than as written. The file may say
   * "." — true and portable, and no use to an agent deciding where to look.
   */
  if (before.cwd !== after.cwd && after.cwd) {
    parts.push(`The working directory is now ${after.cwd}.`);
  }

  const paths = (snapshot: WorkspaceSnapshot) => snapshot.directories.map((dir) => dir.path);
  const added = paths(after).filter((path) => !paths(before).includes(path));
  const removed = paths(before).filter((path) => !paths(after).includes(path));
  if (added.length) parts.push(`The following directories were added:\n\n${bullets(added)}`);
  if (removed.length) parts.push(`The following directories were removed:\n\n${bullets(removed)}`);

  // Resolved, so a permission the file leaves unstated is compared as the
  // default it actually behaves as rather than as absent.
  const permKeys = ["files", "shell", "git"] as const;
  const permChanges = permKeys
    .filter((key) => before.permissions[key] !== after.permissions[key])
    .map((key) => `${key}: ${after.permissions[key]}`);
  if (permChanges.length) parts.push(`Permissions were updated:\n\n${permChanges.join("\n")}`);

  if (before.instructions.join("\n") !== after.instructions.join("\n")) {
    parts.push(
      after.instructions.length
        ? `Workspace instructions are now:\n\n${bullets(after.instructions)}`
        : "Workspace instructions were cleared.",
    );
  }

  // Merged with the global list, so a server added globally is news here too.
  const running = (snapshot: WorkspaceSnapshot) =>
    snapshot.mcpServers.filter((server) => server.enabled).map((server) => server.name);
  const mcpAdded = running(after).filter((name) => !running(before).includes(name));
  const mcpRemoved = running(before).filter((name) => !running(after).includes(name));
  if (mcpAdded.length) parts.push(`MCP servers enabled: ${mcpAdded.join(", ")}`);
  if (mcpRemoved.length) parts.push(`MCP servers disabled: ${mcpRemoved.join(", ")}`);

  // Also merged: some of these come from the global settings.
  if (before.skillPaths.join(",") !== after.skillPaths.join(",")) {
    parts.push(`Skill directories are now: ${after.skillPaths.join(", ") || "(none)"}`);
  }

  // Resources are loaded when a session is built, so say plainly that this one
  // is not affected — otherwise the agent would look for a skill it still has.
  for (const kind of ["skills", "prompts", "extensions"] as const) {
    const turnedOff = after.disabled[kind].filter((name) => !before.disabled[kind].includes(name));
    const turnedOn = before.disabled[kind].filter((name) => !after.disabled[kind].includes(name));
    if (turnedOff.length) parts.push(`${kind} switched off for new sessions: ${turnedOff.join(", ")}`);
    if (turnedOn.length) parts.push(`${kind} switched back on for new sessions: ${turnedOn.join(", ")}`);
  }

  /*
   * Memory (§50). What matters is whether a directory is *readable* now —
   * enabled and actually on disk — not which of the two lists names it.
   *
   * Keyed by name and compared by path, so a directory repointed somewhere else
   * reads as one arriving and one leaving rather than as no change at all.
   */
  const readable = (dirs: ResolvedMemoryDir[]) =>
    new Map(dirs.filter((dir) => dir.enabled && dir.exists).map((dir) => [dir.name, dir.path]));
  const beforeMemory = readable(before.memory);
  const afterMemory = readable(after.memory);

  const memoryAdded = [...afterMemory].filter(([name, path]) => beforeMemory.get(name) !== path);
  const memoryGone = [...beforeMemory].filter(([name, path]) => afterMemory.get(name) !== path);

  if (memoryAdded.length) {
    const list = bullets(memoryAdded.map(([name, path]) => `${name}: ${path}`));
    parts.push(
      `Memory directories you can now read:\n\n${list}\n\n` +
        "A memory store's own instructions are loaded when a session starts, so for this session, look inside before relying on it.",
    );
  }
  if (memoryGone.length) {
    const list = bullets(memoryGone.map(([name, path]) => `${name}: ${path}`));
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
