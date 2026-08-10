import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemorySubject } from "@picone/protocol";
import { findMentions, mentionContext } from "./subjects.ts";

const subject = (over: Partial<MemorySubject> = {}): MemorySubject => ({
  slug: "gio-choi",
  name: "Gio Choi",
  type: "person",
  summary: "Colleague on the weekly check-in.",
  path: "/memory/people/gio-choi.md",
  root: "/memory",
  tags: [],
  ...over,
});

describe("findMentions", () => {
  it("finds a mention at the start and mid-sentence", () => {
    assert.deepEqual(findMentions("@gio-choi said so"), ["gio-choi"]);
    assert.deepEqual(findMentions("what did I promise @gio-choi about it"), ["gio-choi"]);
  });

  it("drops the punctuation that ends the sentence", () => {
    assert.deepEqual(findMentions("ask @gio-choi."), ["gio-choi"]);
    assert.deepEqual(findMentions("(@gio-choi)"), ["gio-choi"]);
  });

  it("is not fooled by an email address", () => {
    assert.deepEqual(findMentions("mail me at tzhang3@uchicago.edu"), []);
  });

  it("deduplicates and lowercases", () => {
    assert.deepEqual(findMentions("@Gio-Choi and @gio-choi"), ["gio-choi"]);
  });

  it("finds several", () => {
    assert.deepEqual(findMentions("@a-one and @b-two"), ["a-one", "b-two"]);
  });

  it("ignores a bare sigil", () => {
    assert.deepEqual(findMentions("email @ me"), []);
  });
});

describe("mentionContext", () => {
  it("adds nothing when nobody was named", () => {
    assert.equal(mentionContext("just a question", [subject()]), null);
  });

  it("hands over a path, and never the page", () => {
    const text = mentionContext("what about @gio-choi", [subject()]);
    assert.ok(text);
    assert.match(text, /Gio Choi/);
    assert.match(text, /\/memory\/people\/gio-choi\.md/);
    // The whole point: the page's own words are not in the prompt.
    assert.doesNotMatch(text, /Colleague on the weekly check-in/);
  });

  it("says so when no page is filed under the name, rather than staying silent", () => {
    const text = mentionContext("what about @joshua", [subject()]);
    assert.ok(text);
    assert.match(text, /@joshua/);
    assert.match(text, /no page is filed/i);
  });

  it("always tells the agent to look past the pointer", () => {
    const text = mentionContext("@gio-choi", [subject()]);
    assert.ok(text);
    assert.match(text, /starting points, not the record/i);
    assert.match(text, /Search the memory directories/i);
  });

  it("covers every name in one block", () => {
    const text = mentionContext("@gio-choi and @julia", [subject(), subject({ slug: "julia", name: "Julia K" })]);
    assert.ok(text);
    assert.match(text, /Gio Choi/);
    assert.match(text, /Julia K/);
  });
});
