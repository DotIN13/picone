import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { memoryRoots, resolveMemoryDirs } from "./registry.ts";

/** A real directory, since resolution checks whether one is there. */
function dir(name: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "picone-mem-"));
  const target = path.join(root, name);
  mkdirSync(target, { recursive: true });
  return target;
}

test("a global directory is offered to a workspace that says nothing", () => {
  const notes = dir("notes");
  const resolved = resolveMemoryDirs({
    global: { notes: { path: notes } },
    workspace: undefined,
    workspaceDir: "D:\\ws",
  });

  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.name, "notes");
  assert.equal(resolved[0]!.enabled, true);
  assert.equal(resolved[0]!.source, "global");
  // And it reaches the file tree, which is the half that went missing.
  assert.deepEqual(memoryRoots(resolved).map((r) => r.name), ["notes"]);
});

test("a workspace switches one off without restating where it lives", () => {
  const notes = dir("notes");
  const resolved = resolveMemoryDirs({
    global: { notes: { path: notes } },
    workspace: { notes: { enabled: false } },
    workspaceDir: "D:\\ws",
  });

  // Still listed — that is where you switch it back on — but not a root.
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]!.enabled, false);
  assert.equal(resolved[0]!.path, notes);
  assert.deepEqual(memoryRoots(resolved), []);
});

test("a workspace's own directory is resolved against the workspace file", () => {
  const base = dir("holder");
  const resolved = resolveMemoryDirs({
    global: undefined,
    workspace: { local: { path: "./holder" } },
    workspaceDir: path.dirname(base),
  });

  assert.equal(resolved[0]!.path, base);
  assert.equal(resolved[0]!.source, "workspace");
});

test("a name with no path anywhere is reported rather than dropped silently", () => {
  const diagnostics: string[] = [];
  const resolved = resolveMemoryDirs({
    global: undefined,
    workspace: { ghost: { enabled: true } },
    workspaceDir: "D:\\ws",
    diagnostics,
  });

  assert.deepEqual(resolved, []);
  assert.match(diagnostics.join("\n"), /"ghost" has no path/);
});

test("a missing directory is listed but is not a root", () => {
  const resolved = resolveMemoryDirs({
    global: { gone: { path: path.join(tmpdir(), "picone-not-here-at-all") } },
    workspace: undefined,
    workspaceDir: "D:\\ws",
  });

  assert.equal(resolved[0]!.exists, false);
  assert.deepEqual(memoryRoots(resolved), []);
});

test("a directory can be open without being drawn", () => {
  const notes = dir("notes");
  const resolved = resolveMemoryDirs({
    global: { notes: { path: notes, hidden: true } },
    workspace: undefined,
    workspaceDir: "D:\ws",
  });

  // Still a root — reachable, readable — and the file explorer skips it (§3).
  assert.equal(resolved[0]!.hidden, true);
  assert.deepEqual(memoryRoots(resolved).map((r) => [r.name, r.hidden]), [["notes", true]]);
});

test("a workspace can hide a directory the global list shows, and vice versa", () => {
  const notes = dir("notes");
  const shown = resolveMemoryDirs({
    global: { notes: { path: notes, hidden: true } },
    workspace: { notes: { hidden: false } },
    workspaceDir: "D:\ws",
  });
  assert.equal(shown[0]!.hidden, false);
  assert.equal(memoryRoots(shown)[0]!.hidden, undefined);

  const hidden = resolveMemoryDirs({
    global: { notes: { path: notes } },
    workspace: { notes: { hidden: true } },
    workspaceDir: "D:\ws",
  });
  assert.equal(hidden[0]!.hidden, true);
});

test("saying nothing leaves a directory drawn", () => {
  const notes = dir("notes");
  const resolved = resolveMemoryDirs({ global: { notes: { path: notes } }, workspace: undefined, workspaceDir: "D:\ws" });
  assert.equal(resolved[0]!.hidden, false);
});
