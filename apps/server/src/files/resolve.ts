import { statSync } from "node:fs";
import path from "node:path";
import type { ResolvedPath } from "@picone/protocol";
import { expandPath, isInside } from "../util/paths.ts";

/**
 * Turning a path a model mentioned into something the browser may show
 * (DESIGN §51).
 *
 * The browser cannot answer any of the three questions that matter — does this
 * exist, is it a file or a directory, is it inside the workspace — so it asks,
 * in batches, and anything that comes back unresolved stays plain text.
 *
 * A miss is as useful an answer as a hit and costs a `stat`, so misses are
 * reported rather than thrown: a transcript full of `and/or` should not be a
 * transcript full of errors.
 */

/** More than a single message could plausibly mention; a guard, not a policy. */
export const MAX_RESOLVE_BATCH = 200;

/**
 * A mentioned path is usually written relative to a root — `src/auth.ts`, not
 * the absolute path — so each root is tried in turn and the first hit wins.
 * Roots are ordered as the workspace lists them, which is the order the user
 * chose, so "first" means "most likely the one they meant".
 */
function candidatesFor(target: string, roots: string[]): string[] {
  const trimmed = target.trim();
  if (!trimmed) return [];

  // `~` and an absolute path both name exactly one place.
  if (trimmed.startsWith("~") || path.isAbsolute(trimmed) || /^[a-z]:[\\/]/i.test(trimmed)) {
    return [expandPath(trimmed)];
  }

  const relative = trimmed.replace(/^\.[\\/]/, "");
  return roots.map((root) => path.resolve(root, relative));
}

export function resolvePaths(roots: string[], targets: string[]): ResolvedPath[] {
  return targets.slice(0, MAX_RESOLVE_BATCH).map((target) => resolveOne(roots, target));
}

function resolveOne(roots: string[], target: string): ResolvedPath {
  for (const absolute of candidatesFor(target, roots)) {
    const root = roots.find((r) => isInside(r, absolute));
    // Outside every root is reported the same way as absent, deliberately: a
    // distinct answer would confirm what lives on the rest of the disk.
    if (!root) continue;

    try {
      const stat = statSync(absolute);
      if (!stat.isFile() && !stat.isDirectory()) continue;
      return {
        path: target,
        exists: true,
        absolute,
        type: stat.isDirectory() ? "directory" : "file",
        root,
        size: stat.size,
        mtime: stat.mtimeMs,
      };
    } catch {
      // Missing, or unreadable — try the next root.
    }
  }

  return { path: target, exists: false };
}
