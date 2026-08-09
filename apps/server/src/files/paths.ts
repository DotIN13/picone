import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Path completion for the workspace picker.
 *
 * Cross-platform by construction: the caller's separator style is detected and
 * echoed back, Windows drive letters are enumerated, `~` expands, and matching
 * is case-insensitive only where the filesystem is.
 */

const IS_WINDOWS = process.platform === "win32";

/** Directories that are never useful to browse into. */
const NOISE = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".Trash",
]);

export interface PathCompletion {
  /** Full path, joined with the separator the caller is using. */
  path: string;
  name: string;
  type: "directory" | "file" | "drive";
  /** True for `*.workspace.json` and similar. */
  workspace?: boolean;
}

export interface CompleteResult {
  /** The directory the completions are drawn from, normalized for display. */
  base: string;
  /** Separator to use when joining — mirrors what the caller typed. */
  separator: "/" | "\\";
  completions: PathCompletion[];
  /** True when `base` does not exist, so the UI can say so rather than show nothing. */
  missing: boolean;
}

export interface InspectResult {
  path: string;
  exists: boolean;
  type: "directory" | "file" | null;
  /** Workspace files directly inside, when `path` is a directory. */
  workspaceFiles: string[];
  /** A sensible workspace name derived from the directory. */
  suggestedName: string;
  isGitRepo: boolean;
  parent: string | null;
}

function isWorkspaceFile(name: string): boolean {
  return name.endsWith(".workspace.json") || name === "workspace.json" || name === "picone.json";
}

/** Mirror whichever separator the user is typing; default to the platform's. */
function detectSeparator(input: string): "/" | "\\" {
  const lastSlash = input.lastIndexOf("/");
  const lastBack = input.lastIndexOf("\\");
  if (lastSlash === -1 && lastBack === -1) return IS_WINDOWS ? "\\" : "/";
  return lastBack > lastSlash ? "\\" : "/";
}

function join(base: string, name: string, separator: "/" | "\\"): string {
  const trimmed = base.replace(/[/\\]+$/, "");
  // A bare Windows drive keeps its separator: "C:" + "\" + "Users".
  if (/^[A-Za-z]:$/.test(trimmed)) return `${trimmed}${separator}${name}`;
  return trimmed === "" ? `${separator}${name}` : `${trimmed}${separator}${name}`;
}

/**
 * Expand `~`.
 *
 * The trailing separator is significant — it is what distinguishes "list this
 * directory" from "match this prefix" — and `path.join` strips it, so it is
 * restored afterwards.
 */
export function expandInput(input: string): string {
  const value = input.trim();
  if (value === "~") return homedir();
  if (!value.startsWith("~/") && !value.startsWith("~\\")) return value;

  const rest = value.slice(2);
  const joined = path.join(homedir(), rest);
  return /[/\\]$/.test(value) && !/[/\\]$/.test(joined) ? joined + path.sep : joined;
}

/** Drive letters that currently exist, for the Windows root listing. */
function windowsDrives(separator: "/" | "\\"): PathCompletion[] {
  const drives: PathCompletion[] = [];
  for (let code = 65; code <= 90; code++) {
    const letter = String.fromCharCode(code);
    const root = `${letter}:\\`;
    try {
      if (existsSync(root)) {
        drives.push({ path: `${letter}:${separator}`, name: `${letter}:`, type: "drive" });
      }
    } catch {
      /* an unreadable drive is simply not offered */
    }
  }
  return drives;
}

function listDirectory(dir: string, prefix: string, separator: "/" | "\\"): PathCompletion[] {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  // Case-insensitive matching on Windows and macOS; exact on Linux.
  const insensitive = IS_WINDOWS || process.platform === "darwin";
  const needle = insensitive ? prefix.toLowerCase() : prefix;

  const out: PathCompletion[] = [];
  for (const entry of entries) {
    const name = entry.name;
    if (NOISE.has(name)) continue;
    // Hidden entries appear only once the user types the dot.
    if (name.startsWith(".") && !prefix.startsWith(".")) continue;

    const candidate = insensitive ? name.toLowerCase() : name;
    if (needle && !candidate.startsWith(needle)) continue;

    let isDir = entry.isDirectory();
    if (entry.isSymbolicLink()) {
      try {
        isDir = statSync(path.join(dir, name)).isDirectory();
      } catch {
        continue;
      }
    }

    out.push({
      path: join(dir, name, separator),
      name,
      type: isDir ? "directory" : "file",
      workspace: !isDir && isWorkspaceFile(name) ? true : undefined,
    });
  }

  // Directories first, then workspace files, then the rest — alphabetically.
  out.sort((a, b) => {
    const rank = (e: PathCompletion) => (e.type === "directory" ? 0 : e.workspace ? 1 : 2);
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  });

  return out.slice(0, 300);
}

/**
 * Complete a partially typed path.
 *
 * A trailing separator means "list this directory"; anything else is treated as
 * a prefix to match inside its parent — the behaviour a shell or VS Code gives.
 */
export function completePath(input: string): CompleteResult {
  const separator = detectSeparator(input);
  const raw = expandInput(input);

  // Nothing typed: offer home and the filesystem roots as starting points.
  if (raw === "") {
    const home = homedir();
    const completions: PathCompletion[] = [
      { path: home + path.sep, name: "~", type: "directory" },
      ...(IS_WINDOWS ? windowsDrives(path.sep as "/" | "\\") : [{ path: "/", name: "/", type: "directory" as const }]),
    ];
    return { base: "", separator: path.sep as "/" | "\\", completions, missing: false };
  }

  // A lone drive letter on Windows: "d" → "D:\"
  if (IS_WINDOWS && /^[A-Za-z]$/.test(raw)) {
    return {
      base: "",
      separator,
      completions: windowsDrives(separator).filter((d) => d.name.toLowerCase().startsWith(raw.toLowerCase())),
      missing: false,
    };
  }

  // "D:" and "D:/" both mean the root of that drive.
  if (IS_WINDOWS && /^[A-Za-z]:[/\\]?$/.test(raw)) {
    const root = `${raw.slice(0, 2)}\\`;
    return {
      base: `${raw.slice(0, 2)}${separator}`,
      separator,
      completions: listDirectory(root, "", separator),
      missing: !existsSync(root),
    };
  }

  const endsWithSeparator = /[/\\]$/.test(raw);
  const dir = endsWithSeparator ? raw : path.dirname(raw);
  const prefix = endsWithSeparator ? "" : path.basename(raw);

  const exists = existsSync(dir);
  return {
    base: dir,
    separator,
    completions: exists ? listDirectory(dir, prefix, separator) : [],
    missing: !exists,
  };
}

/** Everything the picker needs to decide what to offer for a given path. */
export function inspectPath(input: string): InspectResult {
  const target = expandInput(input);
  const parent = path.dirname(target);

  let type: "directory" | "file" | null = null;
  try {
    const stat = statSync(target);
    type = stat.isDirectory() ? "directory" : "file";
  } catch {
    type = null;
  }

  let workspaceFiles: string[] = [];
  if (type === "directory") {
    try {
      workspaceFiles = readdirSync(target, { withFileTypes: true })
        .filter((entry) => entry.isFile() && isWorkspaceFile(entry.name))
        .map((entry) => path.join(target, entry.name));
    } catch {
      workspaceFiles = [];
    }
  }

  return {
    path: target,
    exists: type !== null,
    type,
    workspaceFiles,
    suggestedName: suggestWorkspaceName(target),
    isGitRepo: type === "directory" && existsSync(path.join(target, ".git")),
    parent: parent === target ? null : parent,
  };
}

/** "D:\code\acme-web" → "Acme Web". */
export function suggestWorkspaceName(dir: string): string {
  const base = path.basename(dir.replace(/[/\\]+$/, ""));
  if (!base || /^[A-Za-z]:$/.test(base)) return "Workspace";
  return base
    .replace(/[-_.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}
