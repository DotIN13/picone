import assert from "node:assert/strict";
import { test } from "node:test";
import { FactoryWidget, WIDGET_WIDTH, plainTheme } from "./widget-render.ts";

test("a factory is rendered and its lines handed over", () => {
  const pushed: (string[] | undefined)[] = [];
  const widget = new FactoryWidget(
    (_tui, theme) => ({ render: (width) => [theme.fg("accent", `w=${width}`), theme.bold("two")] }),
    (lines) => pushed.push(lines),
  );
  widget.push();

  assert.deepEqual(pushed, [[`w=${WIDGET_WIDTH}`, "two"]]);
});

test("the theme styles nothing, so no escape codes reach the browser", () => {
  const styled = [
    plainTheme.fg("accent", "a"),
    plainTheme.bg("error", "b"),
    plainTheme.bold("c"),
    plainTheme.italic("d"),
    plainTheme.underline("e"),
    plainTheme.inverse("f"),
    plainTheme.strikethrough("g"),
  ].join("");
  assert.equal(styled, "abcdefg");
  // eslint-disable-next-line no-control-regex
  assert.ok(!//.test(styled), "an ANSI escape survived");
});

test("requestRender re-renders, which is how an extension refreshes", () => {
  // The todo overlay registers once and then calls requestRender on every
  // completed `todo` call; without this the panel would freeze at its first
  // state.
  let count = 0;
  const pushed: string[][] = [];
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
  ask();

  assert.deepEqual(pushed, [["render 1"], ["render 2"], ["render 3"]]);
});

test("a widget that throws yields no lines rather than killing the session", () => {
  const pushed: (string[] | undefined)[] = [];
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

test("dispose reaches the component, so an extension can release what it held", () => {
  let disposed = false;
  const widget = new FactoryWidget(
    () => ({ render: () => [], dispose: () => void (disposed = true) }),
    () => {},
  );
  widget.dispose();
  assert.equal(disposed, true);
});
