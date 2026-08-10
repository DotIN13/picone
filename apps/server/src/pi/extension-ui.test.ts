import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionUiUpdate } from "@picone/protocol";
import { ExtensionUiBridge } from "./extension-ui.ts";

function harness() {
  const updates: ExtensionUiUpdate[] = [];
  const bridge = new ExtensionUiBridge({
    prompt: () => {},
    closePrompt: () => {},
    update: (u) => updates.push(u),
    notify: () => {},
    editorText: () => "typed",
  });
  return { updates, ui: bridge.context() as never as Record<string, never>, bridge };
}

test("a factory widget is rendered to lines", () => {
  const { updates, ui } = harness();
  (ui.setWidget as never as (k: string, c: unknown, o?: unknown) => void)(
    "k",
    () => ({ render: () => ["one", "two"] }),
    { placement: "belowEditor" },
  );
  assert.deepEqual(updates, [{ method: "setWidget", key: "k", lines: ["one", "two"], placement: "belowEditor" }]);
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
    { method: "setChrome", slot: "header", lines: ["hello"] },
    { method: "setChrome", slot: "footer", lines: ["branch=null"] },
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

test("theme is present and styles nothing", () => {
  const { ui } = harness();
  const theme = ui.theme as never as { fg(c: string, t: string): string; bold(t: string): string };
  // It used to be absent, which throws on the first `ctx.ui.theme.fg(...)`.
  assert.equal(typeof theme?.fg, "function");
  assert.equal(theme.fg("accent", "text"), "text");
  assert.equal(theme.bold("text"), "text");
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
