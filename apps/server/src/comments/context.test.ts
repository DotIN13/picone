import assert from "node:assert/strict";
import { test } from "node:test";
import type { FileComment } from "@picone/protocol";
import { commentContext, commentSummary, withCommentBlocks, withCommentSummaries } from "./matcher.ts";

const comment = (over: Partial<FileComment> = {}): FileComment => ({
  id: "c1",
  workspaceId: "w",
  sessionId: "s",
  path: "D:\\work\\report.html",
  matcher: "the retrieval step dominates",
  lineStart: 12,
  lineEnd: 12,
  body: "Does this hold at 8k?",
  status: "open",
  createdAt: "2026-08-11T00:00:00.000Z",
  ...over,
});

test("a message carries its comments after the words", () => {
  const out = withCommentBlocks("can we avoid Redis?", [comment()]);
  assert.ok(out.startsWith("can we avoid Redis?"));
  assert.ok(out.includes("The user left a comment on:"));
  assert.ok(out.includes("Does this hold at 8k?"));
  assert.ok(out.includes("c1"));
});

test("a message that is nothing but a comment reads as one", () => {
  // What sending a comment straight out of a file view used to produce, exactly.
  const alone = withCommentBlocks("", [comment()]);
  assert.equal(alone.startsWith("The user left a comment on:"), true);
  assert.equal(alone.includes("---"), false);
  assert.equal(withCommentSummaries("", [comment()]), commentSummary(comment()));
});

test("several comments are kept apart, in the order they were sent", () => {
  const out = withCommentBlocks("both of these", [comment(), comment({ id: "c2", body: "and this" })]);
  assert.equal(out.split("The user left a comment on:").length - 1, 2);
  assert.ok(out.indexOf("Does this hold at 8k?") < out.indexOf("and this"));
  assert.equal(out.split("\n\n---\n\n").length, 3);
});

test("nothing carried leaves the message alone", () => {
  assert.equal(withCommentBlocks("just a question", []), "just a question");
  assert.equal(withCommentSummaries("just a question", []), "just a question");
});

test("a message naming no file gets nothing", () => {
  assert.equal(commentContext("what changed today?", [comment()]), null);
});

test("naming a file brings its open comments", () => {
  const out = commentContext("look at D:\\work\\report.html please", [comment()]);
  assert.ok(out);
  assert.ok(out.includes("D:\\work\\report.html"));
  assert.ok(out.includes("Does this hold at 8k?"));
  assert.ok(out.includes("line 12"));
  // The id, so the agent can close it when it is done.
  assert.ok(out.includes("c1"));
});

test("either slash finds it", () => {
  // A path typed by hand, or pasted from somewhere that uses forward slashes.
  assert.ok(commentContext("see D:/work/report.html", [comment()]));
  assert.ok(commentContext("see d:\\WORK\\Report.HTML", [comment()]));
});

test("a comment on another file stays out of it", () => {
  const other = comment({ id: "c2", path: "D:\\work\\other.md", body: "unrelated" });
  const out = commentContext("look at D:\\work\\report.html", [comment(), other]);
  assert.ok(out);
  assert.equal(out.includes("unrelated"), false);
});

test("resolved comments are not repeated", () => {
  // They were dealt with; naming the file again should not drag them back.
  const done = comment({ id: "c3", status: "resolved", body: "already handled" });
  assert.equal(commentContext("D:\\work\\report.html", [done]), null);
});

test("several comments on one file are grouped under it once", () => {
  const two = [comment(), comment({ id: "c2", body: "and this one too", lineStart: 40 })];
  const out = commentContext("D:\\work\\report.html", two);
  assert.ok(out);
  assert.equal(out.split("D:\\work\\report.html").length - 1, 1);
  assert.ok(out.includes("and this one too"));
  assert.ok(out.includes("line 40"));
});

test("a comment with no line still reads", () => {
  const loose = comment({ lineStart: undefined, lineEnd: undefined });
  const out = commentContext("D:\\work\\report.html", [loose]);
  assert.ok(out);
  assert.equal(out.includes("line"), false);
  assert.ok(out.includes("Does this hold at 8k?"));
});
