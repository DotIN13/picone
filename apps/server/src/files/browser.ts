import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { DirEntry } from "@picone/protocol";
import { MAX_DIR_ENTRIES } from "../config.ts";

/** Directories we never show in the explorer — they are noise, not work. */
const HIDDEN_DIRS = new Set([
  ".git",
  "node_modules",
  ".next",
  ".turbo",
  ".cache",
  "__pycache__",
  ".venv",
  ".pytest_cache",
  ".mypy_cache",
  ".gradle",
  ".idea",
  ".DS_Store",
]);

export interface ListOptions {
  /** Include dotfiles and the always-hidden directories above. */
  showHidden?: boolean;
}

/**
 * One directory level only — the tree lazy-loads (DESIGN §12).
 */
export function listDirectory(absPath: string, options: ListOptions = {}): DirEntry[] {
  const dirents = readdirSync(absPath, { withFileTypes: true });
  const entries: DirEntry[] = [];

  for (const dirent of dirents) {
    const name = dirent.name;
    if (!options.showHidden) {
      if (HIDDEN_DIRS.has(name)) continue;
      if (name.startsWith(".") && name !== ".env") continue;
    }

    const full = path.join(absPath, name);
    let isDir = dirent.isDirectory();

    // Only a symlink needs a stat, to find out what it points at. Everything
    // else is answered by the readdir itself: asking the filesystem about each
    // entry individually is the whole cost of a listing, and on a network or
    // cloud-synced folder it is the difference between instant and painful.
    if (dirent.isSymbolicLink()) {
      try {
        isDir = statSync(full).isDirectory();
      } catch {
        continue; // broken symlink
      }
    }

    entries.push({ name, path: full, type: isDir ? "directory" : "file" });
    if (entries.length >= MAX_DIR_ENTRIES) break;
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return entries;
}

/** Recursive filename search used by the sidebar filter box. */
export function searchFiles(root: string, query: string, limit = 200): DirEntry[] {
  const needle = query.toLowerCase();
  const results: DirEntry[] = [];
  const stack: string[] = [root];

  while (stack.length > 0 && results.length < limit) {
    const dir = stack.pop()!;
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const dirent of dirents) {
      if (HIDDEN_DIRS.has(dirent.name) || dirent.name.startsWith(".")) continue;
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
      } else if (dirent.name.toLowerCase().includes(needle)) {
        results.push({ name: dirent.name, path: full, type: "file" });
        if (results.length >= limit) break;
      }
    }
  }

  return results;
}
