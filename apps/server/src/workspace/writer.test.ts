import assert from "node:assert/strict";
import { test } from "node:test";
import type { ResolvedMemoryDir } from "@picone/protocol";
import {
  describeWorkspaceChange,
  isWorkspaceSnapshot,
  withWorkspaceUpdate,
  type WorkspaceSnapshot,
} from "./writer.ts";

/** The resolved configuration, which is what a session is compared against. */
const snap = (over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot => ({
  name: "Test",
  cwd: "D:/work",
  directories: [{ path: "D:/work", kind: "cwd", exists: true }],
  memory: [],
  mcpServers: [],
  skillPaths: [],
  permissions: { files: "allow", shell: "ask", git: "ask" },
  instructions: [],
  disabled: { skills: [], prompts: [], extensions: [] },
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

test("an unchanged workspace has nothing to say", () => {
  assert.equal(describeWorkspaceChange(snap(), snap()), null);
});

test("directories are described by where they resolve to, not as written", () => {
  const text = describeWorkspaceChange(
    snap(),
    snap({
      directories: [
        { path: "D:/work", kind: "cwd", exists: true },
        { path: "D:/work/docs", kind: "context", exists: true },
      ],
    }),
  )!;
  // The file may say "."; the agent needs the directory that resolves to.
  assert.match(text, /directories were added[\s\S]*D:\/work\/docs/);
});

test("an MCP server added globally is news, though the workspace file is unchanged", () => {
  // The whole reason the snapshot is resolved: this merge is invisible in the file.
  const text = describeWorkspaceChange(snap(), snap({ mcpServers: [{ name: "brave", enabled: true }] }))!;
  assert.match(text, /MCP servers enabled: brave/);
});

test("a skill directory added globally is news for the same reason", () => {
  const text = describeWorkspaceChange(snap(), snap({ skillPaths: ["C:/global/skills"] }))!;
  assert.match(text, /Skill directories are now: C:\/global\/skills/);
});

test("permissions compare as the defaults they behave as", () => {
  const text = describeWorkspaceChange(snap(), snap({ permissions: { files: "allow", shell: "allow", git: "ask" } }))!;
  assert.match(text, /shell: allow/);
  assert.ok(!text.includes("files:"), "an unchanged permission should not be mentioned");
});

test("a memory directory becoming readable is news", () => {
  const text = describeWorkspaceChange(snap(), snap({ memory: [memory()] }))!;
  assert.match(text, /Memory directories you can now read/);
  assert.match(text, /brain: D:\/brain/);
  assert.match(text, /look inside before relying on it/);
});

test("switching one off, or losing it from disk, is news too", () => {
  const before = snap({ memory: [memory()] });
  assert.match(describeWorkspaceChange(before, snap({ memory: [memory({ enabled: false })] }))!, /no longer available/);
  assert.match(describeWorkspaceChange(before, snap({ memory: [memory({ exists: false })] }))!, /no longer available/);
  assert.match(describeWorkspaceChange(before, snap())!, /no longer available/);
});

test("a memory directory that moved reads as one arriving and one leaving", () => {
  const text = describeWorkspaceChange(
    snap({ memory: [memory({ path: "D:/old" })] }),
    snap({ memory: [memory({ path: "D:/new" })] }),
  )!;
  assert.match(text, /now read[\s\S]*D:\/new/);
  assert.match(text, /no longer available[\s\S]*D:\/old/);
});

test("a disabled or missing directory arriving is not announced as readable", () => {
  assert.equal(describeWorkspaceChange(snap(), snap({ memory: [memory({ enabled: false })] })), null);
  assert.equal(describeWorkspaceChange(snap(), snap({ memory: [memory({ exists: false })] })), null);
});

test("resource switches say plainly that this session keeps what it has", () => {
  const text = describeWorkspaceChange(snap(), snap({ disabled: { skills: ["deploy"], prompts: [], extensions: [] } }))!;
  assert.match(text, /skills switched off for new sessions: deploy/);
});

test("several edits collapse into one paragraph", () => {
  const text = describeWorkspaceChange(
    snap(),
    snap({
      cwd: "D:/elsewhere",
      directories: [{ path: "D:/elsewhere", kind: "cwd", exists: true }],
      permissions: { files: "allow", shell: "allow", git: "ask" },
      memory: [memory()],
      mcpServers: [{ name: "brave", enabled: true }],
    }),
  )!;

  assert.match(text, /working directory is now D:\/elsewhere/);
  assert.match(text, /shell: allow/);
  assert.match(text, /MCP servers enabled: brave/);
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

test("a stored snapshot from an older shape is not trusted", () => {
  // It would otherwise be compared field by field against a shape it lacks,
  // and throw on the first message after an upgrade.
  assert.equal(isWorkspaceSnapshot({ file: { version: 1, name: "Test" }, memory: [] }), false);
  assert.equal(isWorkspaceSnapshot(null), false);
  assert.equal(isWorkspaceSnapshot("{}"), false);
  assert.equal(isWorkspaceSnapshot(snap()), true);
});
