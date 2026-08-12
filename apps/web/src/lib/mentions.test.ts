import assert from "node:assert/strict";
import { test } from "node:test";
import type { MemorySubject } from "@picone/protocol";
import { pillRanges, splitMentions } from "./mentions.ts";

const jul: MemorySubject = {
  slug: "jul",
  name: "Jul",
  type: "person",
  path: "D:\\memory\\people\\jul.md",
  root: "D:\\memory",
  summary: "",
  tags: [],
};

const kinds = (text: string, subjects: MemorySubject[] = [jul]) =>
  splitMentions(text, subjects).map((p) => (p.kind === "text" ? p.text : `${p.kind}:${p.raw}`));

/** The split must always be able to put the text back together again. */
const rebuilt = (text: string, subjects: MemorySubject[] = [jul]) =>
  splitMentions(text, subjects)
    .map((p) => (p.kind === "text" ? p.text : p.raw))
    .join("");

test("a file mention survives being pasted onto the end of a word", () => {
  // The case this exists for: pasted text runs things together, and the first
  // mention used to be the one that silently did not count.
  const text = "sadnn@dashboard.md  @dashboard.md  @dashboard.md ccccccss";
  const found = splitMentions(text, [jul]).filter((p) => p.kind === "file");
  assert.equal(found.length, 3);
  assert.equal(rebuilt(text), text);
});

test("an email address is not a mention", () => {
  for (const address of ["write to me@example.com now", "ping ops@picone.io", "x@thing.co"]) {
    assert.deepEqual(
      splitMentions(address, [jul]).filter((p) => p.kind !== "text"),
      [],
      address,
    );
  }
});

test("a subject still has to start a word", () => {
  // `@jul` glued to a word is an address-shaped thing, and the server agrees.
  assert.deepEqual(kinds("mail@jul today"), ["mail@jul today"]);
  assert.deepEqual(kinds("ask @jul today"), ["ask ", "subject:@jul", " today"]);
});

test("both kinds come back from one pass", () => {
  assert.deepEqual(kinds("ask @jul about @notes.md please"), [
    "ask ",
    "subject:@jul",
    " about ",
    "file:@notes.md",
    " please",
  ]);
});

test("a known subject wins over the filename shape", () => {
  const readme: MemorySubject = { ...jul, slug: "readme.md", name: "Readme" };
  assert.deepEqual(kinds("see @readme.md", [readme]), ["see ", "subject:@readme.md"]);
});

test("text with no mentions is one part, unchanged", () => {
  assert.deepEqual(kinds("nothing to see here"), ["nothing to see here"]);
  assert.equal(rebuilt(""), "");
});

test("ranges line up with the text, for both kinds", () => {
  const text = "ask @jul about @notes.md please";
  const ranges = pillRanges(text, [jul]);
  assert.deepEqual(ranges.map((r) => text.slice(r.start, r.end)), ["@jul", "@notes.md"]);
});

test("ranges stay correct with several mentions in a row", () => {
  // The offsets are what the atomic delete uses; drift here deletes the wrong
  // characters, and it compounds with each mention.
  const text = "sadnn@a.md @b.md @c.md tail";
  const ranges = pillRanges(text, [jul]);
  assert.deepEqual(ranges.map((r) => text.slice(r.start, r.end)), ["@a.md", "@b.md", "@c.md"]);
});

test("a trailing full stop belongs to the sentence, not the name", () => {
  assert.deepEqual(kinds("look at @notes.md."), ["look at ", "file:@notes.md", "."]);
});
