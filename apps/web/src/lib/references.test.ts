import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { marked, type Token } from "marked";
import { fenceClosed } from "./fences.ts";
import { classifyTarget, extensionOf, findReferences, isPathLike, segment } from "./references.ts";

const targets = (text: string) => findReferences(text).map((r) => `${r.kind}:${r.target}`);

describe("extensionOf", () => {
  it("lowercases and ignores query and hash", () => {
    assert.equal(extensionOf("shot.PNG"), ".png");
    assert.equal(extensionOf("https://x.test/a/b.svg?v=2#top"), ".svg");
  });

  it("is empty for a dotfile or an extensionless name", () => {
    assert.equal(extensionOf(".gitignore"), "");
    assert.equal(extensionOf("src/components"), "");
    // A dot in a directory earlier in the path is not the file's extension.
    assert.equal(extensionOf("v1.2/README"), "");
  });
});

describe("classifyTarget", () => {
  it("reads media from the extension, wherever it is hosted", () => {
    assert.equal(classifyTarget("out/shot.png"), "image");
    assert.equal(classifyTarget("https://x.test/shot.png"), "image");
    assert.equal(classifyTarget("clip.mp4"), "video");
    assert.equal(classifyTarget("take.m4a"), "audio");
    assert.equal(classifyTarget("spec.pdf"), "pdf");
  });

  it("treats a bare http(s) target as a page", () => {
    assert.equal(classifyTarget("https://example.test/docs"), "webpage");
  });

  it("falls back to file for a local path", () => {
    assert.equal(classifyTarget("src/auth.ts"), "file");
    assert.equal(classifyTarget("src/components"), "file");
  });

  it("keeps its hands off other schemes", () => {
    assert.equal(classifyTarget("mailto:a@b.test"), null);
    assert.equal(classifyTarget("data:image/png;base64,AAAA"), null);
    assert.equal(classifyTarget("#anchor"), null);
    assert.equal(classifyTarget(""), null);
  });

  it("does not mistake a Windows drive for a scheme", () => {
    assert.equal(classifyTarget("D:\\projects\\app\\main.ts"), "file");
    assert.equal(classifyTarget("C:/Users/me/shot.png"), "image");
  });
});

describe("isPathLike", () => {
  it("accepts the shapes a model actually writes", () => {
    for (const ok of [
      "src/auth.ts",
      "./apps/web/src/App.tsx",
      "../shared/util.ts",
      "~/notes.md",
      "/etc/hosts",
      "D:\\dotty-projects\\picone\\README.md",
      "README.md",
      "docs/todo/media-previews.md",
      "my-file.test.ts",
    ]) {
      assert.equal(isPathLike(ok), true, ok);
    }
  });

  it("rejects the prose that would otherwise flood the batch", () => {
    for (const no of [
      "and/or",
      "24/7",
      "1/2",
      "2026/08/09",
      "v1.2.3",
      "https://x.test/a",
      "",
      "word",
      "he said",
      'say"what',
      "a".repeat(300),
    ]) {
      assert.equal(isPathLike(no), false, no);
    }
  });

  it("keeps hyphens, which are in half the directories on disk", () => {
    assert.equal(isPathLike("dotty-projects/picone/README.md"), true);
  });

  it("rejects slash commands, which this app's own transcripts are full of", () => {
    for (const command of ["/new", "/close", "/settings", "/theme", "/sidebar", "/api"]) {
      assert.equal(isPathLike(command), false, command);
    }
    // Two segments is a path again, even though it may not exist.
    assert.equal(isPathLike("/api/models"), true);
    assert.equal(isPathLike("/etc/hosts"), true);
  });

  it("rejects two capitalised words joined by a slash", () => {
    assert.equal(isPathLike("Rendered/Source"), false);
  });
});

describe("findReferences", () => {
  it("finds a path in ordinary prose", () => {
    assert.deepEqual(targets("I updated src/auth.ts today."), ["file:src/auth.ts"]);
  });

  it("strips the punctuation a sentence wraps around a path", () => {
    assert.deepEqual(targets("see (docs/DESIGN.md), then stop."), ["file:docs/DESIGN.md"]);
    assert.deepEqual(targets("open 'src/a.ts'!"), ["file:src/a.ts"]);
  });

  it("keeps a bracket that belongs to the name", () => {
    assert.deepEqual(targets("out/(gen)/x.ts"), ["file:out/(gen)/x.ts"]);
  });

  it("matches URLs before paths, so a URL is not shredded", () => {
    assert.deepEqual(targets("docs at https://example.test/a/b.html now"), [
      "webpage:https://example.test/a/b.html",
    ]);
  });

  it("reports offsets that address the original string", () => {
    const text = "before src/a.ts after";
    const [ref] = findReferences(text);
    assert.ok(ref);
    assert.equal(text.slice(ref.start, ref.end), "src/a.ts");
  });

  it("returns references in source order", () => {
    assert.deepEqual(targets("b/x.ts then https://x.test/p then a/y.png"), [
      "file:b/x.ts",
      "webpage:https://x.test/p",
      "image:a/y.png",
    ]);
  });

  it("finds nothing in prose that merely contains slashes", () => {
    assert.deepEqual(targets("this and/or that, 24/7, on 2026/08/09"), []);
  });
});

describe("segment", () => {
  it("returns one text segment when there is nothing to find", () => {
    assert.deepEqual(segment("just words"), [{ text: "just words" }]);
  });

  it("interleaves text and references without losing a character", () => {
    const text = "see src/a.ts and out/b.png here";
    const parts = segment(text);
    const rebuilt = parts.map((p) => ("text" in p ? p.text : p.reference.target)).join("");
    assert.equal(rebuilt, text);
    assert.equal(parts.filter((p) => "reference" in p).length, 2);
  });
});

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

/**
 * A message is rendered while it arrives, so the interesting question is what
 * every *prefix* of it produces, not just the finished text.
 */
describe("streaming", () => {
  const types = (src: string): string[] => {
    const out: string[] = [];
    const walk = (tokens: Token[] | undefined) => {
      for (const token of tokens ?? []) {
        out.push(token.type);
        walk(("tokens" in token ? token.tokens : undefined) as Token[] | undefined);
      }
    };
    walk(marked.lexer(src));
    return out;
  };

  it("produces no image token until the construct is complete", () => {
    const text = "shot: ![alt](out/gradient.png) done.";
    const complete = text.indexOf(")") + 1;
    for (let i = 1; i < complete; i++) {
      assert.equal(types(text.slice(0, i)).includes("image"), false, `half-written at ${i}`);
    }
    assert.equal(types(text.slice(0, complete)).includes("image"), true);
  });

  it("knows a fence is still open, because marked emits code from the first tick", () => {
    const open = "```mermaid\n";
    const partial = "```mermaid\ngraph TD\n  A-->";
    const closed = "```mermaid\ngraph TD\n  A-->B\n```\n";
    const tildes = "~~~mermaid\ngraph TD\n  A-->B\n~~~";
    const indented = "```mermaid\ngraph TD\n  A-->B\n  ```\n";

    // This is why a diagram waits: the token exists long before the graph does.
    assert.equal(types(open).includes("code"), true);

    assert.equal(fenceClosed(open), false);
    assert.equal(fenceClosed(partial), false);
    assert.equal(fenceClosed(closed), true);
    assert.equal(fenceClosed(tildes), true);
    assert.equal(fenceClosed(indented), true);
  });

  it("never turns a half-written path into a reference that resolves", () => {
    // "out/sho" has no extension and two lowercase segments: rejected outright.
    assert.equal(isPathLike("out/sho"), false);
    // Once an extension appears it is a candidate, and the server decides.
    assert.equal(isPathLike("out/shot.png"), true);
  });
});
