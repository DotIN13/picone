import type { PermissionCategory } from "@picone/protocol";

/** Built-in Pi tools that touch the filesystem. */
const FILE_TOOLS = new Set(["read", "write", "edit", "ls", "grep", "find", "multiedit"]);

/**
 * Tools that execute processes. `bash` is Pi's built-in, but extensions and
 * packages add their own shells (a `pwsh` tool on Windows, for example), and
 * those must go through the same gate.
 */
const SHELL_TOOLS = new Set([
  "bash",
  "sh",
  "shell",
  "zsh",
  "pwsh",
  "powershell",
  "cmd",
  "terminal",
  "exec",
  "execute",
  "run",
  "run_command",
  "execute_command",
  "run_shell_command",
]);

/** Argument names that betray a shell tool we do not otherwise recognise. */
const COMMAND_FIELDS = ["command", "cmd", "script", "shellCommand", "shell_command"];

/** Argument combinations that betray a file-mutating tool. */
const FILE_MUTATION_FIELDS = ["content", "contents", "old_string", "new_string", "patch", "diff", "replacement"];

/** git subcommands that only observe state (DESIGN §9). */
const READONLY_GIT = new Set([
  "status",
  "diff",
  "log",
  "show",
  "blame",
  "branch",
  "remote",
  "config",
  "rev-parse",
  "describe",
  "ls-files",
  "shortlog",
  "reflog",
  "stash",
  "tag",
  "worktree",
]);

/** git subcommands that mutate repository state and deserve their own gate. */
const MUTATING_GIT = new Set([
  "commit",
  "checkout",
  "switch",
  "merge",
  "rebase",
  "push",
  "pull",
  "fetch",
  "reset",
  "revert",
  "cherry-pick",
  "clean",
  "apply",
  "am",
  "restore",
  "rm",
  "mv",
  "add",
  "init",
  "clone",
  "submodule",
]);

export interface Classification {
  /** null means the call needs no permission check (custom/MCP tools). */
  category: PermissionCategory | null;
  /** Human-readable subject for the permission card. */
  detail: string;
  title: string;
  cwd?: string;
}

export function classifyToolCall(toolName: string, input: unknown): Classification {
  const args = (input ?? {}) as Record<string, unknown>;
  const name = toolName.toLowerCase();

  const commandField = COMMAND_FIELDS.find((field) => typeof args[field] === "string");
  if (SHELL_TOOLS.has(name) || commandField) {
    const command = commandField ? String(args[commandField]) : "";
    return {
      category: classifyShellCommand(command),
      detail: command || toolName,
      title: "Pi wants to run",
      cwd: typeof args.cwd === "string" ? args.cwd : undefined,
    };
  }

  const target =
    (typeof args.path === "string" && args.path) ||
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.pattern === "string" && args.pattern) ||
    "";

  const looksLikeFileMutation = target !== "" && FILE_MUTATION_FIELDS.some((field) => field in args);
  if (FILE_TOOLS.has(name) || looksLikeFileMutation) {
    return {
      category: "files",
      detail: `${toolName} ${target}`.trim(),
      title: `Pi wants to use the ${toolName} tool on`,
    };
  }

  return { category: null, detail: toolName, title: `Pi wants to use ${toolName}` };
}

/**
 * `git push && npm test` is two different questions. We take the strictest
 * category present: any non-git segment makes the whole call a shell request.
 */
export function classifyShellCommand(command: string): PermissionCategory | null {
  const segments = splitCommand(command);
  if (segments.length === 0) return "shell";

  let sawGitMutation = false;
  let sawReadonlyGit = false;

  for (const segment of segments) {
    const tokens = tokenize(segment);
    if (tokens.length === 0) continue;

    const bin = baseName(tokens[0]!);
    if (bin !== "git") return "shell";

    const sub = tokens.slice(1).find((t) => !t.startsWith("-"));
    if (!sub) {
      sawReadonlyGit = true;
      continue;
    }
    if (MUTATING_GIT.has(sub)) sawGitMutation = true;
    else if (READONLY_GIT.has(sub)) sawReadonlyGit = true;
    else sawGitMutation = true; // unknown git subcommand: treat as mutating
  }

  if (sawGitMutation) return "git";
  if (sawReadonlyGit) return null; // read-only git is always allowed
  return "shell";
}

function splitCommand(command: string): string[] {
  return command
    .split(/\r?\n|&&|\|\||;|\|/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

function tokenize(segment: string): string[] {
  const tokens = segment.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return tokens
    .map((t) => t.replace(/^['"]|['"]$/g, ""))
    // Drop leading `VAR=value` assignments and common wrappers.
    .filter((t, i) => !(i === 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(t)));
}

function baseName(bin: string): string {
  const parts = bin.split(/[\\/]/);
  return (parts[parts.length - 1] ?? bin).replace(/\.exe$/i, "");
}

/** Stable key so "allow for session" covers repeats of the same request. */
export function grantKey(category: PermissionCategory, detail: string): string {
  return `${category}:${detail.trim()}`;
}
