import assert from "node:assert/strict";
import { test } from "node:test";
import type { WidgetLine } from "@picone/protocol";
import { parseWidgetRows, type WidgetRow } from "./widget-lines.ts";

const rows = (lines: WidgetLine[]) =>
  parseWidgetRows(lines).filter((r): r is Extract<WidgetRow, { kind: "row" }> => r.kind === "row");
const text = (row: Extract<WidgetRow, { kind: "row" }>) => row.spans.map((s) => s.text).join("");
const plain = (s: string): WidgetLine => [{ text: s }];

test("a task list becomes a heading and rows at depth", () => {
  const parsed = rows([
    [{ text: "● Todos (1/2)" }],
    [{ text: "├─ " }, { text: "✓", role: "success" }, { text: " Done thing" }],
    [{ text: "└─ " }, { text: "○", role: "dim" }, { text: " Pending thing" }],
  ]);

  assert.deepEqual(parsed.map((r) => [r.depth, r.heading, text(r)]), [
    [0, true, "● Todos (1/2)"],
    [1, false, "✓ Done thing"],
    [1, false, "○ Pending thing"],
  ]);
  // The status came from the widget's own declaration, not from the glyph.
  assert.equal(parsed[1]!.spans[0]!.role, "success");
  assert.equal(parsed[2]!.spans[0]!.role, "dim");
});

test("the columns before a branch are depth", () => {
  const parsed = rows([plain("● Top"), plain("├─ one"), plain("│  ├─ two"), plain("│  │  └─ three")]);
  assert.deepEqual(parsed.map((r) => r.depth), [0, 1, 2, 3]);
});

test("a bare indent counts as depth", () => {
  const parsed = rows([plain("● Jobs"), plain("  running · 1m55s")]);
  assert.equal(parsed[1]!.depth, 1);
  assert.equal(text(parsed[1]!), "running · 1m55s");
});

test("a continuation under a branch lands in the branch's column", () => {
  // `│  ` and `   ` are what a terminal draws below `├─ ` and `└─ `; all three
  // are one level, so all three indent the same here.
  const parsed = rows([
    plain("● Background jobs"),
    plain("├─ bg-4  python x.py"),
    plain("│  running · 1m55s"),
    plain("└─ bg-5  npm run build"),
    plain("   done · exit 0"),
  ]);

  assert.deepEqual(parsed.map((r) => r.depth), [0, 1, 1, 1, 1]);
  // The bar itself is layout, and the layout now says it.
  assert.deepEqual(parsed.map(text), [
    "● Background jobs",
    "bg-4  python x.py",
    "running · 1m55s",
    "bg-5  npm run build",
    "done · exit 0",
  ]);
});

test("a Windows path survives intact", () => {
  // Backslashes are text like any other. Nothing here escapes or unescapes.
  const path = ["D:", "dotty-projects", "agent-bridge"].join(String.fromCharCode(92));
  const parsed = rows([plain("● Jobs"), [{ text: "├─ " }, { text: `bg-4  cd ${path}; python x.py` }]]);
  assert.equal(text(parsed[1]!), `bg-4  cd ${path}; python x.py`);
  assert.ok(text(parsed[1]!).includes(String.fromCharCode(92, 100, 111, 116, 116, 121)));
});

test("dropping the tree glyphs spans the span boundary", () => {
  // The branch is usually its own dim span; the text after it is another.
  const parsed = rows([[{ text: "├", role: "dim" }, { text: "─ " }, { text: "after" }]]);
  assert.equal(text(parsed[0]!), "after");
  assert.equal(parsed[0]!.depth, 1);
});

test("blank lines collapse to one gap, and never trail", () => {
  const parsed = parseWidgetRows([plain("● One"), [], [], plain("two"), [], plain("   ")]);
  assert.deepEqual(parsed.map((r) => r.kind), ["row", "gap", "row"]);
});

test("the padding a widget rendered to its width is dropped", () => {
  const parsed = rows([[{ text: "● Jobs" }, { text: "   " }], [{ text: "├─ one" }, { text: "  ", role: "dim" }]]);
  assert.deepEqual(parsed.map(text), ["● Jobs", "one"]);
  // A span that was nothing but padding goes with it.
  assert.equal(parsed[1]!.spans.length, 1);
});

test("nothing in, nothing out", () => {
  assert.deepEqual(parseWidgetRows([]), []);
  assert.deepEqual(parseWidgetRows([[], plain("  ")]), []);
});
