import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Finding the Claude CLI (§57).
 *
 * The SDK is a thin client for a native binary it normally installs as an
 * optional dependency — 283 MB of it, per platform. It does not look on `PATH`:
 * without that package it fails with "Native CLI binary for win32-x64 not
 * found" rather than falling back. So the looking is ours to do, and doing it
 * means a Picone install can skip the binary entirely when the machine already
 * has Claude Code on it, which most machines running this will.
 *
 * Order: an explicit setting, then `PATH`, then nothing — which leaves the SDK
 * to find its own bundled copy and to say so if there isn't one.
 */

/** Override for a Claude Code that is installed somewhere unusual. */
export const CLAUDE_PATH_ENV = "PICONE_CLAUDE_PATH";

export function claudeExecutable(override?: string): string | undefined {
  for (const candidate of [override, process.env[CLAUDE_PATH_ENV]]) {
    if (candidate && existsSync(candidate)) return candidate;
  }

  // `claude` with no extension is the launcher on POSIX; on Windows the real
  // binary is `claude.exe`, with `.cmd` for npm-installed copies.
  const names = process.platform === "win32" ? ["claude.exe", "claude.cmd", "claude"] : ["claude"];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Whether a Claude session could be started, and what is missing if not. */
export function claudeAvailability(override?: string): { available: boolean; reason?: string } {
  if (claudeExecutable(override)) return { available: true };
  return {
    available: false,
    reason:
      "No Claude Code executable found. Install Claude Code, or set " +
      `${CLAUDE_PATH_ENV} to where it lives.`,
  };
}
