import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import type { GitStatus } from "@picone/protocol";

const exec = promisify(execFile);

export interface GitChange {
  path: string;
  status: GitStatus;
}

function mapCode(code: string): GitStatus {
  if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
  if (code.includes("?")) return "untracked";
  if (code.includes("R")) return "renamed";
  if (code.includes("D")) return "deleted";
  if (code.includes("A")) return "added";
  return "modified";
}

/**
 * Changed-file state for the explorer (DESIGN §12). Best effort: a root that is
 * not a git repository simply reports nothing.
 */
export async function gitChanges(root: string): Promise<GitChange[]> {
  try {
    const { stdout } = await exec("git", ["status", "--porcelain=v1", "-z", "--untracked-files=normal"], {
      cwd: root,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });

    const changes: GitChange[] = [];
    const records = stdout.split("\0");
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const code = record.slice(0, 2);
      let file = record.slice(3);
      if (code.includes("R")) {
        // Rename records are followed by the original path in the next field.
        i++;
      }
      if (!file) continue;
      changes.push({ path: path.resolve(root, file), status: mapCode(code) });
    }
    return changes;
  } catch {
    return [];
  }
}

export async function isGitRepo(root: string): Promise<boolean> {
  try {
    await exec("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, windowsHide: true });
    return true;
  } catch {
    return false;
  }
}
