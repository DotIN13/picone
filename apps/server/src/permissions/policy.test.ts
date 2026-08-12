import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyToolCall } from "./policy.ts";

/**
 * The gate was written around Pi's tool names and has to hold for Claude's,
 * which are the same tools in title case (§57). Nothing here is about Claude
 * in particular: a tool is classified by what it does.
 */
test("Claude's file tools classify like Pi's", () => {
  assert.equal(classifyToolCall("Read", { file_path: "a.ts" }).category, "files");
  assert.equal(classifyToolCall("Glob", { pattern: "**/*" }).category, "files");
  assert.deepEqual(classifyToolCall("Write", { file_path: "a.ts", content: "x" }).writes, ["a.ts"]);
  assert.deepEqual(classifyToolCall("Edit", { file_path: "a.ts", old_string: "x", new_string: "y" }).writes, ["a.ts"]);
});

test("a notebook edit is a write, and its target is checked", () => {
  // NotebookEdit names its file `notebook_path`, which nothing else does — so
  // it went through the gate without its target being looked at.
  const call = classifyToolCall("NotebookEdit", { notebook_path: "n.ipynb", new_source: "print(1)" });
  assert.equal(call.category, "files");
  assert.deepEqual(call.writes, ["n.ipynb"]);
});

test("Claude's shell is the same shell", () => {
  assert.equal(classifyToolCall("Bash", { command: "rm -rf x" }).category, "shell");
  assert.equal(classifyToolCall("Bash", { command: "git status" }).category, null);
  assert.equal(classifyToolCall("Bash", { command: "git push" }).category, "git");
});

test("the card names the agent that is asking", () => {
  assert.equal(classifyToolCall("Bash", { command: "ls" }, "Claude").title, "Claude wants to run");
  assert.equal(classifyToolCall("read", { path: "a" }, "Pi").title, "Pi wants to use the read tool on");
  // Nobody said who, so it does not claim to know.
  assert.match(classifyToolCall("Bash", { command: "ls" }).title, /^The agent wants/);
});
