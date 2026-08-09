import { writeFileSync } from "node:fs";
import type { Workspace, WorkspaceFile } from "@picone/protocol";
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
 * Describes a config change in one short paragraph so the running session can be
 * told what happened without rebuilding its context (DESIGN §34).
 */
export function describeWorkspaceChange(before: WorkspaceFile, after: WorkspaceFile): string | null {
  const parts: string[] = [];

  const added = after.directories.filter((d) => !before.directories.includes(d));
  const removed = before.directories.filter((d) => !after.directories.includes(d));
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

  const beforeSkills = (before.skills ?? []).map((s) => s.name).join(",");
  const afterSkills = (after.skills ?? []).map((s) => s.name).join(",");
  if (beforeSkills !== afterSkills) parts.push(`Skill directories are now: ${afterSkills || "(none)"}`);

  // Resources are loaded when a session is built, so say plainly that this one
  // is not affected — otherwise the agent would look for a skill it still has.
  for (const kind of ["skills", "prompts", "extensions"] as const) {
    const wasOff = before.disabled?.[kind] ?? [];
    const isOff = after.disabled?.[kind] ?? [];
    const turnedOff = isOff.filter((n) => !wasOff.includes(n));
    const turnedOn = wasOff.filter((n) => !isOff.includes(n));
    if (turnedOff.length) parts.push(`${kind} switched off for new sessions: ${turnedOff.join(", ")}`);
    if (turnedOn.length) parts.push(`${kind} switched back on for new sessions: ${turnedOn.join(", ")}`);
  }

  if (!parts.length) return null;
  return `Workspace update:\n\n${parts.join("\n\n")}`;
}
