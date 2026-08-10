import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDetails, summarizeArgs } from "./events.ts";

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

test("structured details are passed through", () => {
  const details = { action: "create", tasks: [{ id: 1, subject: "x", status: "pending" }] };
  assert.deepEqual(extractDetails({ details }), details);
});

test("a patch-only payload is not passed through, since it is drawn as a diff", () => {
  assert.equal(extractDetails({ details: { patch: "--- a\n+++ b" } }), undefined);
  assert.equal(extractDetails({ details: {} }), undefined);
  assert.equal(extractDetails({}), undefined);
});

test("an oversized payload is dropped rather than stored with the transcript", () => {
  const huge = { blob: "x".repeat(20_000) };
  assert.equal(extractDetails({ details: huge }), undefined);
});

test("a payload that cannot be serialised is dropped", () => {
  const circular: Record<string, unknown> = { a: 1 };
  circular.self = circular;
  assert.equal(extractDetails({ details: circular }), undefined);
});
