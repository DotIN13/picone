import assert from "node:assert/strict";
import { test } from "node:test";
import { extractDetails } from "./events.ts";

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
