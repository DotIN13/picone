import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWorkspacePath } from "./workspace-paths.ts";

const SEP = String.fromCharCode(92);
/** `D:\dotty-projects\my.workspace.json`, built to keep the escaping honest. */
const FILE = `D:${SEP}dotty-projects${SEP}my.workspace.json`;
const DIR = `D:${SEP}dotty-projects`;

test("a dot is the workspace's own directory", () => {
  assert.equal(resolveWorkspacePath(".", FILE), DIR);
  assert.equal(resolveWorkspacePath("./", FILE), DIR);
});

test("a relative path hangs off it, in the file's own separator", () => {
  assert.equal(resolveWorkspacePath("picone", FILE), `${DIR}${SEP}picone`);
  assert.equal(resolveWorkspacePath("./picone/docs", FILE), `${DIR}${SEP}picone/docs`);
  assert.equal(resolveWorkspacePath("notes", "/home/t/ws.json"), "/home/t/notes");
});

test("an absolute path is left alone, in every spelling", () => {
  const paths = [`D:${SEP}elsewhere`, "C:/other", "/usr/local", `${SEP}${SEP}server${SEP}share`, "~/notes"];
  for (const path of paths) {
    assert.equal(resolveWorkspacePath(path, FILE), path);
  }
});

test("with nothing to resolve against, the value stands as typed", () => {
  assert.equal(resolveWorkspacePath("picone", undefined), "picone");
  assert.equal(resolveWorkspacePath("", FILE), "");
});
