import { homedir } from "node:os";
import path from "node:path";

/** Expand a leading `~` and normalize to an absolute path. */
export function expandPath(input: string, base?: string): string {
  let p = input.trim();
  if (p === "~") p = homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(homedir(), p.slice(2));
  if (!path.isAbsolute(p) && base) p = path.resolve(base, p);
  return path.normalize(path.resolve(p));
}

/** True when `child` is inside `parent` (or is `parent` itself). */
export function isInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * Guard every filesystem read behind the workspace roots so the browser cannot
 * walk the whole disk through the REST API.
 */
export function resolveWithinRoots(roots: string[], target: string): string | null {
  const abs = expandPath(target);
  return roots.some((root) => isInside(root, abs)) ? abs : null;
}

export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}
