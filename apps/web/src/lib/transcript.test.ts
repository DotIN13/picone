import assert from "node:assert/strict";
import { test } from "node:test";
import type { ChatItem } from "@picone/protocol";
import { upsertItem } from "./transcript.ts";

const tool = (id: string, output: string, status = "running"): ChatItem =>
  ({ kind: "tool", id, at: "2026-08-10T00:00:00.000Z", toolCall: { id, name: "bash", status, output } }) as never;

test("an unknown item is appended", () => {
  const items: ChatItem[] = [];
  upsertItem(items, tool("a", "one"));
  assert.equal(items.length, 1);
  assert.equal(items[0]!.id, "a");
});

test("an update keeps the object's identity", () => {
  const items: ChatItem[] = [];
  upsertItem(items, tool("a", "one"));
  const first = items[0];

  upsertItem(items, tool("a", "one two"));

  // The reason this matters: `<For>` keys on reference, so a new object here is
  // a rebuilt row, and a rebuilt row forgets that its output was expanded.
  assert.equal(items.length, 1);
  assert.equal(items[0], first, "the item was replaced rather than merged");
  assert.equal((items[0] as never as { toolCall: { output: string } }).toolCall.output, "one two");
});

test("only changed fields are written", () => {
  const items: ChatItem[] = [];
  upsertItem(items, tool("a", "one"));

  const written: string[] = [];
  const spy = new Proxy(items[0] as never as Record<string, unknown>, {
    set(target, key, value) {
      written.push(String(key));
      target[key as string] = value;
      return true;
    },
  });
  items[0] = spy as never;

  // Same `at`, same kind, different toolCall — only the one field should move.
  upsertItem(items, tool("a", "one two"));
  assert.deepEqual(written, ["toolCall"]);
});

test("a change of kind replaces, because the shapes differ", () => {
  const items: ChatItem[] = [];
  upsertItem(items, tool("a", "one"));
  const first = items[0];

  const asMessage = { kind: "assistant", id: "a", text: "done", at: "2026-08-10T00:00:00.000Z" } as never as ChatItem;
  upsertItem(items, asMessage);

  assert.notEqual(items[0], first);
  assert.equal(items[0]!.kind, "assistant");
  assert.ok(!("toolCall" in (items[0] as object)), "a stale key survived the change of shape");
});
