import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { MemoryDirs, ResolvedMemoryDir, WorkspaceRoot } from "@picone/protocol";
import { expandPath } from "../util/paths.ts";

/**
 * Memory directories, merged and resolved (DESIGN §50).
 *
 * The global list is offered to every workspace; a workspace switches one off
 * or adds its own. Unlike MCP servers — where a workspace entry *replaces* the
 * global one — these merge field by field, because `{ "enabled": false }` has
 * to mean "not here" without restating where the directory lives.
 */

/** A store that explains itself does so in this file, the way Pi's own tree does. */
const INSTRUCTIONS = "AGENTS.md";
const INDEX = "index.md";

export function resolveMemoryDirs(options: {
  global: MemoryDirs | undefined;
  workspace: MemoryDirs | undefined;
  /** Directory of the workspace file, for resolving its relative paths. */
  workspaceDir: string;
  diagnostics?: string[];
}): ResolvedMemoryDir[] {
  const global = options.global ?? {};
  const workspace = options.workspace ?? {};
  const names = [...new Set([...Object.keys(global), ...Object.keys(workspace)])].sort((a, b) =>
    a.localeCompare(b),
  );

  const out: ResolvedMemoryDir[] = [];
  for (const name of names) {
    const inherited = global[name];
    const local = workspace[name];
    const rawPath = local?.path ?? inherited?.path;

    if (!rawPath) {
      // A workspace toggling a name nothing defines. Worth saying so: it is
      // almost always a global entry that has since been renamed or removed.
      options.diagnostics?.push(`Memory directory "${name}" has no path; the global entry it refers to is gone.`);
      continue;
    }

    // Only a workspace's own path is workspace-relative. A global one has no
    // file to be relative to.
    const resolved = local?.path ? expandPath(local.path, options.workspaceDir) : expandPath(rawPath);

    out.push({
      name,
      path: resolved,
      enabled: (local?.enabled ?? inherited?.enabled ?? true) !== false,
      writable: (local?.writable ?? inherited?.writable ?? false) === true,
      source: local?.path ? "workspace" : "global",
      hidden: (local?.hidden ?? inherited?.hidden ?? false) === true,
      ...inspect(resolved),
    });
  }
  return out;
}

/** What the settings list shows and the context builder branches on. */
function inspect(dir: string): Pick<ResolvedMemoryDir, "exists" | "hasInstructions" | "hasIndex" | "entries"> {
  let exists = false;
  try {
    exists = statSync(dir).isDirectory();
  } catch {
    exists = false;
  }
  if (!exists) return { exists: false, hasInstructions: false, hasIndex: false, entries: 0 };

  let entries = 0;
  try {
    entries = readdirSync(dir).length;
  } catch {
    entries = 0;
  }

  return {
    exists: true,
    hasInstructions: existsSync(path.join(dir, INSTRUCTIONS)),
    hasIndex: existsSync(path.join(dir, INDEX)),
    entries,
  };
}

/**
 * The roots a memory directory contributes to the workspace: enabled ones that
 * are actually there. A disabled or missing directory is still listed in
 * settings — that is where you switch it back on, or find out it moved — but it
 * is not somewhere the file tree or the agent should be looking.
 */
export function memoryRoots(dirs: ResolvedMemoryDir[]): WorkspaceRoot[] {
  return dirs
    .filter((dir) => dir.enabled && dir.exists)
    .map((dir) => ({
      name: dir.name,
      path: dir.path,
      exists: true,
      kind: "memory" as const,
      writable: dir.writable,
      ...(dir.hidden ? { hidden: true } : {}),
    }));
}

export { INSTRUCTIONS as MEMORY_INSTRUCTIONS_FILE, INDEX as MEMORY_INDEX_FILE };
