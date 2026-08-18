import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DRAFT_MIME,
  draftComments,
  draftForModel,
  draftLabel,
  draftIsEmpty,
  draftText,
  normalize,
  parseDraft,
  serializeDraft,
  textDraft,
  type Draft,
} from "./draft.ts";

const file = (label: string, id: string): Draft[number] => ({ type: "mention", kind: "file", id, label });
const subject = (label: string, id: string): Draft[number] => ({ type: "mention", kind: "subject", id, label });
const parked = (label: string, id: string): Draft[number] => ({ type: "mention", kind: "comment", id, label });

const draft: Draft = [
  { type: "text", text: "ask " },
  subject("Jul", "jul"),
  { type: "text", text: " about " },
  file("notes.md", "D:\\work\\notes.md"),
  { type: "text", text: " today" },
];

test("what the reader sees is labels", () => {
  assert.equal(draftText(draft), "ask @Jul about @notes.md today");
});

test("what the agent gets is identities", () => {
  // A file becomes the path — the thing that can be opened, and the thing its
  // comments are matched against. A subject stays a slug; the server expands it.
  assert.equal(draftForModel(draft), "ask @jul about D:\\work\\notes.md today");
});

test("two files with the same name stay apart", () => {
  // The whole reason the draft is not a string: these are indistinguishable
  // once flattened, and only the model knows which is which.
  const both: Draft = [file("notes.md", "D:\\a\\notes.md"), { type: "text", text: " vs " }, file("notes.md", "D:\\b\\notes.md")];
  assert.equal(draftText(both), "@notes.md vs @notes.md");
  assert.equal(draftForModel(both), "D:\\a\\notes.md vs D:\\b\\notes.md");
});

test("adjacent text merges and empties vanish", () => {
  const messy: Draft = [
    { type: "text", text: "a" },
    { type: "text", text: "" },
    { type: "text", text: "b" },
    file("x.md", "D:\\x.md"),
    { type: "text", text: "" },
  ];
  assert.deepEqual(normalize(messy), [{ type: "text", text: "ab" }, file("x.md", "D:\\x.md")]);
});

test("emptiness is about what was said, not what was typed", () => {
  assert.equal(draftIsEmpty([]), true);
  assert.equal(draftIsEmpty(textDraft("   ")), true);
  // A comment pill is worth sending on its own, and it reads as nothing.
  assert.equal(draftIsEmpty([parked("DESIGN.md:42", "c1")]), false);
  assert.equal(draftIsEmpty([file("x.md", "D:\\x.md")]), false);
});

test("a parked comment travels as an id, not as words", () => {
  const carried: Draft = [{ type: "text", text: "and this " }, parked("DESIGN.md:42", "c1")];
  // Neither reading spells it out: the server has the row and composes both (§19).
  assert.equal(draftText(carried), "and this ");
  assert.equal(draftForModel(carried), "and this ");
  assert.deepEqual(draftComments(carried), ["c1"]);
});

test("a comment is drawn as a place, a name as a name", () => {
  // No sigil on a comment: what marks it out is an icon, which is not text.
  assert.equal(draftLabel({ type: "mention", kind: "comment", id: "c1", label: "DESIGN.md:42" }), "DESIGN.md:42");
  assert.equal(draftLabel({ type: "mention", kind: "file", id: "notes.md", label: "notes.md" }), "@notes.md");
});

test("comments come back in the order their pills sit in", () => {
  const two: Draft = [parked("a.md:1", "c1"), { type: "text", text: " and " }, parked("b.md:2", "c2")];
  assert.deepEqual(draftComments(two), ["c1", "c2"]);
  assert.deepEqual(draftComments(textDraft("nothing to carry")), []);
});

test("a comment pill survives the clipboard, id and all", () => {
  assert.deepEqual(parseDraft(serializeDraft([parked("DESIGN.md:42", "c1")])), [parked("DESIGN.md:42", "c1")]);
});

test("a draft survives the clipboard whole", () => {
  const back = parseDraft(serializeDraft(draft));
  assert.deepEqual(back, normalize(draft));
  assert.equal(DRAFT_MIME, "application/x-picone-draft");
});

test("clipboard payloads that are not ours are refused", () => {
  // Better to fall back to text/plain than to trust a shape we did not write.
  for (const bad of ["", "null", "{}", '"text"', "[42]", '[{"type":"mention"}]', '[{"type":"other"}]']) {
    assert.equal(parseDraft(bad), null, bad);
  }
});

test("a mention with a missing kind is not silently a file", () => {
  assert.equal(parseDraft('[{"type":"mention","kind":"folder","id":"x","label":"x"}]'), null);
});
