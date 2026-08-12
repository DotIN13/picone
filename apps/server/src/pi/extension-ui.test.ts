import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionUiUpdate } from "@picone/protocol";
import { ExtensionUiBridge } from "./extension-ui.ts";
import { parseSpans } from "./widget-render.ts";

function harness() {
  const updates: ExtensionUiUpdate[] = [];
  const prompts: { id: string; method: string; lines?: unknown[] }[] = [];
  const frames: { id: string; lines: unknown[] }[] = [];
  const closed: string[] = [];
  const bridge = new ExtensionUiBridge({
    prompt: (p) => void prompts.push(p as never),
    closePrompt: (id) => void closed.push(id),
    update: (u) => void updates.push(u),
    frame: (id, lines) => void frames.push({ id, lines }),
    notify: () => {},
    editorText: () => "typed",
  });
  return { updates, prompts, frames, closed, ui: bridge.context() as never as Record<string, never>, bridge };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Carriage return, as a terminal sends Enter. */
const ENTER = String.fromCharCode(13);

test("a factory widget is rendered to lines", () => {
  const { updates, ui } = harness();
  (ui.setWidget as never as (k: string, c: unknown, o?: unknown) => void)(
    "k",
    () => ({ render: () => ["one", "two"] }),
    { placement: "belowEditor" },
  );
  assert.deepEqual(updates, [
    { method: "setWidget", key: "k", lines: [[{ text: "one" }], [{ text: "two" }]], placement: "belowEditor" },
  ]);
});

test("a header and a footer are rendered from their factories", () => {
  const { updates, ui } = harness();
  (ui.setHeader as never as (f: unknown) => void)(() => ({ render: () => ["hello"] }));
  // The footer factory is called with a data provider as its third argument;
  // an extension that reads it should not crash.
  (ui.setFooter as never as (f: unknown) => void)((_t: unknown, _th: unknown, data: { getGitBranch(): string | null }) => ({
    render: () => [`branch=${String(data.getGitBranch())}`],
  }));

  assert.deepEqual(updates, [
    { method: "setChrome", slot: "header", lines: [[{ text: "hello" }]] },
    { method: "setChrome", slot: "footer", lines: [[{ text: "branch=null" }]] },
  ]);
});

test("clearing a header sends no lines rather than nothing at all", () => {
  const { updates, ui } = harness();
  (ui.setHeader as never as (f: unknown) => void)(undefined);
  assert.deepEqual(updates, [{ method: "setChrome", slot: "header", lines: undefined }]);
});

test("the working row is describable", () => {
  const { updates, ui } = harness();
  (ui.setWorkingMessage as never as (m?: string) => void)("compiling");
  (ui.setWorkingVisible as never as (v: boolean) => void)(false);
  (ui.setWorkingIndicator as never as (o?: { frames?: string[] }) => void)({ frames: ["●"] });
  (ui.setHiddenThinkingLabel as never as (l?: string) => void)("pondering");

  assert.deepEqual(updates, [
    { method: "setWorkingMessage", message: "compiling" },
    { method: "setWorkingVisible", visible: false },
    { method: "setWorkingIndicator", frames: ["●"] },
    { method: "setHiddenThinkingLabel", label: "pondering" },
  ]);
});

test("tool expansion is readable synchronously and pushed when set", () => {
  const { updates, ui } = harness();
  const get = ui.getToolsExpanded as never as () => boolean;
  const set = ui.setToolsExpanded as never as (v: boolean) => void;

  // The getter cannot wait on a browser, so the server owns the value.
  assert.equal(get(), false);
  set(true);
  assert.equal(get(), true);
  assert.deepEqual(updates, [{ method: "setToolsExpanded", expanded: true }]);
});

test("the theme a widget draws through records the role it asked for", () => {
  const { ui } = harness();
  const theme = ui.theme as never as { fg(c: string, t: string): string; bold(t: string): string };
  // It used to be absent, which throws on the first `ctx.ui.theme.fg(...)`.
  assert.equal(typeof theme?.fg, "function");
  // Marked rather than coloured, so the browser is told `accent`, not a hex.
  assert.deepEqual(parseSpans(theme.fg("accent", "text")), [{ text: "text", role: "accent" }]);
  assert.deepEqual(parseSpans(theme.bold("text")), [{ text: "text", bold: true }]);
  assert.equal((ui.getTheme as never as (n: string) => unknown)("anything") !== undefined, true);
});

test("disposing the bridge disposes the widgets it is holding", () => {
  const { ui, bridge } = harness();
  let disposed = false;
  (ui.setWidget as never as (k: string, c: unknown) => void)("k", () => ({
    render: () => ["x"],
    dispose: () => void (disposed = true),
  }));
  bridge.dispose();
  assert.equal(disposed, true);
});

test("a custom component is shown, driven by keys, and returns its result", async () => {
  const { prompts, frames, closed, ui, bridge } = harness();
  const custom = ui.custom as never as (f: unknown) => Promise<string | undefined>;

  let typed = "";
  const result = custom((tui: { requestRender(): void }, _theme: unknown, _kb: unknown, done: (r: string) => void) => ({
    render: () => [`typed: ${typed}`],
    handleInput: (data: string) => {
      if (data === ENTER) {
        done(typed);
        return;
      }
      typed += data;
      tui.requestRender();
    },
  }));
  await tick();

  // Shown, with its first frame.
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0]!.method, "custom");
  assert.deepEqual(prompts[0]!.lines, [[{ text: "typed: " }]]);

  const id = prompts[0]!.id;
  bridge.key(id, "h");
  bridge.key(id, "i");
  assert.deepEqual(frames.map((f) => f.lines), [[[{ text: "typed: h" }]], [[{ text: "typed: hi" }]]]);

  bridge.key(id, ENTER);
  assert.equal(await result, "hi");
  assert.deepEqual(closed, [id], "the dialog was not dismissed");
});

test("dismissing a custom component resolves it rather than hanging", async () => {
  const { prompts, ui, bridge } = harness();
  const custom = ui.custom as never as (f: unknown) => Promise<string | undefined>;

  const result = custom(() => ({ render: () => ["waiting"] }));
  await tick();

  // An extension awaiting this must never be left waiting.
  bridge.answer({ id: prompts[0]!.id, cancelled: true });
  assert.equal(await result, undefined);
});

test("a component that will not construct resolves instead of throwing", async () => {
  const { prompts, ui } = harness();
  const custom = ui.custom as never as (f: unknown) => Promise<string | undefined>;
  const result = custom(() => {
    throw new Error("no");
  });
  assert.equal(await result, undefined);
  assert.equal(prompts.length, 0, "a dialog was shown for a component that does not exist");
});

test("a keystroke for an unknown component is ignored", () => {
  const { bridge } = harness();
  assert.doesNotThrow(() => bridge.key("nope", "x"));
});
