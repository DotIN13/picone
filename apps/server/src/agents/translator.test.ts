import assert from "node:assert/strict";
import { test } from "node:test";
import { summarizeArgs } from "./translator.ts";

test("an unknown tool's arguments read as words, not JSON", () => {
  // This is what the todo tool sends, and it used to render as
  // {"action":"update","id":4,"status":"completed"} — mostly punctuation.
  assert.equal(summarizeArgs("todo", { action: "update", id: 4, status: "completed" }), "update · id 4 · completed");
  assert.equal(summarizeArgs("thing", { mode: "management" }), "management");
});

test("known tools keep their own summaries", () => {
  assert.equal(summarizeArgs("read", { path: "a/b.ts" }), "a/b.ts");
  assert.equal(summarizeArgs("bash", { command: "ls -la" }), "ls -la");
});

test("arguments with nothing scalar fall back to JSON", () => {
  assert.equal(summarizeArgs("thing", { nested: { a: 1 } }), '{"nested":{"a":1}}');
});

test("the same tool is summarised the same whichever agent named it", () => {
  // Pi calls it `read`, Claude calls it `Read`, and both mean the file.
  assert.equal(summarizeArgs("Read", { file_path: "a/b.ts" }), "a/b.ts");
  assert.equal(summarizeArgs("Edit", { file_path: "a/b.ts", old_string: "x", new_string: "y" }), "a/b.ts");
  assert.equal(summarizeArgs("Bash", { command: "ls -la", description: "list" }), "ls -la");
  assert.equal(summarizeArgs("Glob", { pattern: "**/*.ts" }), "**/*.ts");
  assert.equal(summarizeArgs("NotebookEdit", { notebook_path: "n.ipynb", new_source: "x" }), "n.ipynb");
});
