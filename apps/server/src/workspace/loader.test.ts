import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { loadWorkspace, workspaceContext } from "./loader.ts";

/** A workspace file on disk, with the directories it names created for real. */
function workspace(file: Record<string, unknown>, dirs: string[] = []): string {
  const root = mkdtempSync(path.join(tmpdir(), "picone-ws-"));
  for (const dir of dirs) mkdirSync(path.join(root, dir), { recursive: true });
  const target = path.join(root, "test.workspace.json");
  writeFileSync(target, JSON.stringify({ version: 1, name: "Test", ...file }));
  return target;
}

test("a cwd and its context directories resolve in order", () => {
  const ws = loadWorkspace(workspace({ cwd: "./work", context: ["./notes", "./spec"] }, ["work", "notes", "spec"]));

  assert.deepEqual(
    ws.roots.map((r) => [r.kind, r.name]),
    [
      ["cwd", "work"],
      ["context", "notes"],
      ["context", "spec"],
    ],
  );
  assert.equal(path.basename(ws.cwd!), "work");
  assert.deepEqual(ws.diagnostics, []);
});

test("the older flat list still opens: first entry is the cwd", () => {
  // A workspace file written before this existed must not need editing.
  const ws = loadWorkspace(workspace({ directories: ["./a", "./b", "./c"] }, ["a", "b", "c"]));

  assert.deepEqual(
    ws.roots.map((r) => [r.kind, r.name]),
    [
      ["cwd", "a"],
      ["context", "b"],
      ["context", "c"],
    ],
  );
});

test("an explicit cwd keeps every legacy entry as context", () => {
  const ws = loadWorkspace(workspace({ cwd: "./work", directories: ["./a", "./b"] }, ["work", "a", "b"]));
  assert.deepEqual(
    ws.roots.map((r) => [r.kind, r.name]),
    [
      ["cwd", "work"],
      ["context", "a"],
      ["context", "b"],
    ],
  );
});

test("a context directory may sit inside the cwd", () => {
  // Nesting is the point: pulling a subdirectory up to the top of the sidebar
  // is why someone would list it separately at all.
  const ws = loadWorkspace(workspace({ cwd: "./work", context: ["./work/docs"] }, ["work/docs"]));

  assert.equal(ws.roots.length, 2);
  assert.equal(ws.roots[1]!.kind, "context");
  assert.ok(ws.roots[1]!.path.startsWith(ws.cwd!), "the context directory should be inside the cwd");
  assert.deepEqual(ws.diagnostics, []);
});

test("the same directory twice is reported, not opened twice", () => {
  const ws = loadWorkspace(workspace({ cwd: "./work", context: ["./work"] }, ["work"]));
  assert.equal(ws.roots.length, 1);
  assert.equal(ws.diagnostics.length, 1);
  assert.match(ws.diagnostics[0]!, /Duplicate/);
});

test("a missing directory is a diagnostic, not a failure", () => {
  const ws = loadWorkspace(workspace({ cwd: "./work", context: ["./gone"] }, ["work"]));
  assert.equal(ws.roots.length, 2);
  assert.equal(ws.roots[1]!.exists, false);
  assert.match(ws.diagnostics.join("\n"), /does not exist/);
});

test("the agent is told the paths and their purpose, and nothing more", () => {
  const ws = loadWorkspace(workspace({ cwd: "./work", context: ["./notes"] }, ["work", "notes"]));
  const context = workspaceContext(ws);

  assert.match(context, /Working directory: .*work/);
  assert.match(context, /Also open, and writable, alongside it/);
  assert.match(context, /notes/);
  // Minimal disclosure: pointers, not an inventory of what is inside them.
  assert.ok(context.length < 1200, `context is ${context.length} chars; it should stay a pointer list`);
});

test("memory directories stay out of the workspace description", () => {
  const ws = loadWorkspace(workspace({ cwd: "./work" }, ["work"]));
  ws.roots.push({ name: "brain", path: "/tmp/brain", exists: true, kind: "memory", writable: false });

  // They are readable roots, but listing them here sends the agent looking for
  // source files in them; they have their own context file (§50).
  assert.ok(!workspaceContext(ws).includes("brain"));
});
