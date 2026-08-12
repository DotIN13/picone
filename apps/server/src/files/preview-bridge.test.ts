import assert from "node:assert/strict";
import { test } from "node:test";
import { withSelectionBridge } from "./preview-bridge.ts";

const page = (body: string) => `<!doctype html><html><head></head><body>${body}</body></html>`;

test("the bridge goes in last, so it never delays the page", () => {
  const out = withSelectionBridge(page("<h1>Report</h1>"));
  assert.ok(out.indexOf("<h1>Report</h1>") < out.indexOf("data-picone-bridge"));
  assert.ok(out.indexOf("data-picone-bridge") < out.indexOf("</body>"));
});

test("a fragment with no body still gets it", () => {
  const out = withSelectionBridge("<h1>Bare</h1>");
  assert.ok(out.startsWith("<h1>Bare</h1>"));
  assert.ok(out.includes("data-picone-bridge"));
});

test("a page is otherwise untouched", () => {
  // The file is served to be *run*, so nothing about it may be rewritten.
  const original = page('<p class="x">text &amp; entities</p><script>var a = 1 < 2;</script>');
  const out = withSelectionBridge(original);
  assert.equal(out.replace(/<script data-picone-bridge>[\s\S]*?<\/script>/, ""), original);
});

test("an upper-case body tag is found too", () => {
  const out = withSelectionBridge("<HTML><BODY><p>hi</p></BODY></HTML>");
  assert.ok(out.indexOf("data-picone-bridge") < out.toLowerCase().indexOf("</body>"));
});

test("the last body wins, not a mention of one earlier", () => {
  const out = withSelectionBridge(page("<pre>&lt;/body&gt;</pre>"));
  assert.ok(out.indexOf("data-picone-bridge") > out.indexOf("<pre>"));
  assert.equal(out.slice(out.indexOf("data-picone-bridge")).includes("<pre>"), false);
});

test("it posts the selected text and where it sits, and nothing else", () => {
  const out = withSelectionBridge(page(""));
  assert.ok(out.includes('source: "picone-preview"'));
  assert.ok(out.includes("text: text"));
  // The rectangle is what lets the comment button appear beside the words.
  assert.ok(out.includes("box: box"));
  assert.ok(out.includes("getBoundingClientRect"));
  // And nothing that would carry the page itself out with it.
  assert.equal(/document\.(cookie|location)|innerHTML|outerHTML/.test(out), false);
});
