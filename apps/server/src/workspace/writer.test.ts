import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedMemoryDir, WorkspaceFile } from "@picone/protocol";
import { describeWorkspaceChange, withWorkspaceUpdate, type WorkspaceSnapshot } from "./writer.ts";

const file = (over: Partial<WorkspaceFile> = {}): WorkspaceFile => ({
  version: 1,
  name: "Test",
  cwd: "D:/work",
  ...over,
});

const memory = (over: Partial<ResolvedMemoryDir> = {}): ResolvedMemoryDir => ({
  name: "brain",
  path: "D:/brain",
  enabled: true,
  writable: false,
  source: "global",
  exists: true,
  hasInstructions: false,
  hasIndex: false,
  entries: 0,
  ...over,
});

const snap = (f: WorkspaceFile, m: ResolvedMemoryDir[] = []): WorkspaceSnapshot => ({ file: f, memory: m });

test("an unchanged workspace has nothing to say", () => {
  assert.equal(describeWorkspaceChange(snap(file()), snap(file())), null);
});

test("a memory directory becoming readable is news", () => {
  const text = describeWorkspaceChange(snap(file()), snap(file(), [memory()]));
  assert.ok(text);
  assert.match(text, /Memory directories you can now read/);
  assert.match(text, /brain: D:\/brain/);
  // The store's own instructions went in at session start, so this session has
  // access without the description that usually comes with it.
  assert.match(text, /look inside before relying on it/);
});

test("switching one off, or losing it from disk, is news too", () => {
  const before = snap(file(), [memory()]);
  assert.match(describeWorkspaceChange(before, snap(file(), [memory({ enabled: false })]))!, /no longer available/);
  assert.match(describeWorkspaceChange(before, snap(file(), [memory({ exists: false })]))!, /no longer available/);
  assert.match(describeWorkspaceChange(before, snap(file(), []))!, /no longer available/);
});

test("a directory that moved reads as one arriving and one leaving", () => {
  const text = describeWorkspaceChange(
    snap(file(), [memory({ path: "D:/old" })]),
    snap(file(), [memory({ path: "D:/new" })]),
  )!;
  assert.match(text, /now read[\s\S]*D:\/new/);
  assert.match(text, /no longer available[\s\S]*D:\/old/);
});

test("a disabled directory arriving is not announced as readable", () => {
  assert.equal(describeWorkspaceChange(snap(file()), snap(file(), [memory({ enabled: false })])), null);
  assert.equal(describeWorkspaceChange(snap(file()), snap(file(), [memory({ exists: false })])), null);
});

test("several edits collapse into one paragraph", () => {
  // The point of deferring: five changes between two messages arrive once.
  const text = describeWorkspaceChange(
    snap(file(), []),
    snap(file({ cwd: "D:/elsewhere", context: ["D:/spec"], permissions: { shell: "allow" } }), [memory()]),
  )!;

  assert.match(text, /working directory is now D:\/elsewhere/);
  assert.match(text, /directories were added/);
  assert.match(text, /shell: allow/);
  assert.match(text, /Memory directories you can now read/);
  assert.equal(text.startsWith("Workspace update:"), true);
});

test("an update rides in front of the message, behind a divider", () => {
  const update = ["Workspace update:", "shell: allow"].join("\n\n");
  const composed = withWorkspaceUpdate(update, "fix the tests");

  // The divider is load-bearing: without it the settings paragraph reads as
  // something the human typed, and gets answered instead of absorbed.
  assert.equal(composed, ["Workspace update:", "shell: allow", "---", "fix the tests"].join("\n\n"));
});

test("with nothing pending the message goes as written", () => {
  assert.equal(withWorkspaceUpdate(null, "fix the tests"), "fix the tests");
});
