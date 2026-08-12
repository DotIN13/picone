import assert from "node:assert/strict";
import { test } from "node:test";
import type { WidgetLine } from "@picone/protocol";
import { FactoryWidget, markingTheme, parseSpans, plainLines } from "./widget-render.ts";

const ESC = String.fromCharCode(27);
const BACKSLASH = String.fromCharCode(92);

test("a role survives the round trip through the render", () => {
  // What the widget declared is what comes back — no colour matching, because
  // the code was one we handed out.
  const drawn = markingTheme.fg("success", "✓");
  assert.deepEqual(parseSpans(drawn), [{ text: "✓", role: "success" }]);
});

test("roles nest with plain text around them", () => {
  const line = `├─ ${markingTheme.fg("warning", "◐")} Draw the list`;
  assert.deepEqual(parseSpans(line), [
    { text: "├─ " },
    { text: "◐", role: "warning" },
    { text: " Draw the list" },
  ]);
});

test("bold is carried, and closed", () => {
  assert.deepEqual(parseSpans(`${markingTheme.bold("Head")}tail`), [{ text: "Head", bold: true }, { text: "tail" }]);
});

test("a Windows path passes through untouched", () => {
  // The reason this has its own test: the escapes we add are ANSI, and a
  // backslash is not one. Nothing in this path escapes or unescapes text.
  const path = ["D:", "dotty-projects", "agent-bridge"].join(BACKSLASH);
  const line = `${markingTheme.fg("muted", "bg-4")}  cd ${path}; python x.py`;

  const spans = parseSpans(line);
  assert.deepEqual(spans, [
    { text: "bg-4", role: "muted" },
    { text: `  cd ${path}; python x.py` },
  ]);
  assert.equal(spans.map((s) => s.text).join(""), `bg-4  cd ${path}; python x.py`);
});

test("a backslash immediately before an escape is kept", () => {
  const line = `ends with${BACKSLASH}${markingTheme.fg("dim", "then dim")}`;
  assert.deepEqual(parseSpans(line), [{ text: `ends with${BACKSLASH}` }, { text: "then dim", role: "dim" }]);
});

test("ANSI we did not write is dropped, and its text kept", () => {
  // An extension colouring by hand gets its words through with no role, which
  // is the same outcome as never having styled them.
  // Unstyled either side of it, so it is one span: the sequence left no trace.
  assert.deepEqual(parseSpans(`${ESC}[31mred${ESC}[0m plain`), [{ text: "red plain" }]);
});

test("adjacent runs of the same styling are one span", () => {
  const line = markingTheme.fg("dim", "a") + markingTheme.fg("dim", "b");
  assert.deepEqual(parseSpans(line), [{ text: "ab", role: "dim" }]);
});

test("a widget that supplied strings has no roles to recover", () => {
  assert.deepEqual(plainLines(["one", "", "two"]), [[{ text: "one" }], [], [{ text: "two" }]]);
});

test("a factory is rendered and its spans handed over", () => {
  const pushed: WidgetLine[][] = [];
  const widget = new FactoryWidget(
    (_tui, theme) => ({ render: (width) => [`${theme.fg("accent", "●")} w=${width}`] }),
    (lines) => pushed.push(lines),
  );
  widget.push();

  assert.deepEqual(pushed.at(-1), [[{ text: "●", role: "accent" }, { text: " w=160" }]]);
});

test("requestRender re-renders, which is how an extension refreshes", () => {
  let count = 0;
  const pushed: WidgetLine[][] = [];
  let ask: () => void = () => {};
  const widget = new FactoryWidget(
    (tui) => {
      ask = () => tui.requestRender();
      return { render: () => [`render ${++count}`] };
    },
    (lines) => pushed.push(lines),
  );
  widget.push();
  ask();

  assert.deepEqual(pushed.map((lines) => lines[0]![0]!.text), ["render 1", "render 2"]);
});

test("a widget that throws yields nothing rather than killing the session", () => {
  const pushed: WidgetLine[][] = [];
  const widget = new FactoryWidget(
    () => ({
      render: () => {
        throw new Error("bad widget");
      },
    }),
    (lines) => pushed.push(lines),
  );

  assert.doesNotThrow(() => widget.push());
  assert.deepEqual(pushed, [[]]);
});

test("dispose reaches the component", () => {
  let disposed = false;
  const widget = new FactoryWidget(() => ({ render: () => [], dispose: () => void (disposed = true) }), () => {});
  widget.dispose();
  assert.equal(disposed, true);
});
