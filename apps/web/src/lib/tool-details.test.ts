import assert from "node:assert/strict";
import { test } from "node:test";
import { asTodoDetails, describeDetails, todoProgress } from "./tool-details.ts";

const task = (id: number, subject: string, status: string) => ({ id, subject, status });

test("a task list is recognised by its shape, not the tool's name", () => {
  const details = asTodoDetails({
    action: "update",
    tasks: [task(1, "one", "completed"), task(2, "two", "in_progress")],
  });
  assert.ok(details);
  assert.equal(details.action, "update");
  assert.equal(details.tasks.length, 2);
});

test("a list is rejected unless every task checks out", () => {
  // Half-recognising would render half the rows, which is worse than none.
  assert.equal(asTodoDetails({ tasks: [task(1, "one", "completed"), { id: 2 }] }), null);
  assert.equal(asTodoDetails({ tasks: [task(1, "one", "elsewhere")] }), null);
  assert.equal(asTodoDetails({ tasks: [] }), null);
  assert.equal(asTodoDetails({ mode: "management", results: [] }), null);
  assert.equal(asTodoDetails(null), null);
  assert.equal(asTodoDetails("tasks"), null);
});

test("deleted tasks are gone from the count and the list", () => {
  const progress = todoProgress([
    { id: 1, subject: "a", status: "completed" },
    { id: 2, subject: "b", status: "pending" },
    { id: 3, subject: "c", status: "deleted" },
  ]);
  assert.equal(progress.total, 2);
  assert.equal(progress.done, 1);
  assert.deepEqual(progress.visible.map((t) => t.id), [1, 2]);
});

test("a list of records becomes a table, whatever the records are about", () => {
  // The point of matching on shape: no extension is named here.
  const nodes = describeDetails({
    mode: "management",
    results: [
      { name: "reviewer", state: "done", ms: 1840 },
      { name: "tester", state: "failed", ms: 920 },
    ],
  });

  assert.deepEqual(nodes[0], { kind: "field", key: "mode", value: "management" });
  assert.deepEqual(nodes[1], {
    kind: "table",
    key: "results",
    columns: ["name", "state", "ms"],
    rows: [
      ["reviewer", "done", "1840"],
      ["tester", "failed", "920"],
    ],
  });
});

test("rows need not agree on every column", () => {
  const nodes = describeDetails({ runs: [{ a: 1 }, { b: 2 }] });
  const table = nodes[0] as { columns: string[]; rows: string[][] };
  assert.deepEqual(table.columns, ["a", "b"]);
  assert.deepEqual(table.rows, [["1", ""], ["", "2"]]);
});

test("a flat object is a one-row table, and scalars are fields", () => {
  const nodes = describeDetails({ counts: { added: 3, removed: 1 }, ok: true });
  assert.deepEqual(nodes[0], { kind: "table", key: "counts", columns: ["added", "removed"], rows: [["3", "1"]] });
  assert.deepEqual(nodes[1], { kind: "field", key: "ok", value: "true" });
});

test("a list of strings stays a list", () => {
  assert.deepEqual(describeDetails({ files: ["a.ts", "b.ts"] }), [
    { kind: "list", key: "files", items: ["a.ts", "b.ts"] },
  ]);
});

test("what will not fit a shape falls back to JSON rather than a wrong guess", () => {
  const nodes = describeDetails({ deep: { a: { b: { c: 1 } } } });
  assert.equal(nodes[0]!.kind, "json");
  assert.ok((nodes[0] as { text: string }).text.includes('"c": 1'));
});

test("what is drawn elsewhere is not drawn twice", () => {
  assert.deepEqual(describeDetails({ tasks: [task(1, "x", "pending")] }), []);
  assert.deepEqual(describeDetails({ patch: "--- a" }), []);
  assert.deepEqual(describeDetails({}), []);
  assert.deepEqual(describeDetails(undefined), []);
});
