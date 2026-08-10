/**
 * Finding the things in a message that are worth showing rather than naming
 * (DESIGN §51).
 *
 * Pure on purpose. Every heuristic here is a guess about prose written by a
 * model, which is exactly the kind of code that needs tuning against real
 * examples, and tuning is only cheap if it is testable without a browser.
 *
 * Nothing here decides whether a path *exists* — the browser cannot know that.
 * These functions produce candidates; the server resolves them, and anything
 * that fails to resolve stays plain text. That division is what lets the
 * scanner be liberal: a false positive costs one entry in a batched lookup and
 * then disappears, rather than turning `and/or` into a broken link.
 */

/** Extensions we can show, as opposed to merely name. */
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".bmp", ".ico"]);
const AUDIO_EXT = new Set([".mp3", ".wav", ".m4a", ".ogg", ".oga", ".flac", ".aac", ".opus"]);
const VIDEO_EXT = new Set([".mp4", ".webm", ".mov", ".m4v", ".ogv"]);
const PDF_EXT = new Set([".pdf"]);

export type ReferenceKind = "image" | "audio" | "video" | "pdf" | "webpage" | "file" | "directory";

export interface Reference {
  kind: ReferenceKind;
  /** The path or URL itself, stripped of surrounding punctuation. */
  target: string;
  /** Offsets into the string that was scanned, so the caller can split it. */
  start: number;
  end: number;
}

/** A scanned string, cut into literal text and the references found in it. */
export type Segment = { text: string } | { reference: Reference };

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The extension of a path or URL, lowercased, with any query or hash removed. */
export function extensionOf(target: string): string {
  const clean = target.split(/[?#]/, 1)[0] ?? target;
  const base = clean.slice(Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\")) + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/**
 * What a target looks like from its spelling alone. `file` is the fallback for
 * a local path, and may turn out to be a `directory` once the server has
 * looked — the string cannot tell you.
 *
 * Returns null for anything we will not touch: a `mailto:`, a `data:` URI, an
 * anchor within the document.
 */
export function classifyTarget(target: string): ReferenceKind | null {
  if (!target || target.startsWith("#")) return null;

  const ext = extensionOf(target);
  const media = (): ReferenceKind | null =>
    IMAGE_EXT.has(ext) ? "image" : AUDIO_EXT.has(ext) ? "audio" : VIDEO_EXT.has(ext) ? "video" : null;

  if (/^https?:\/\//i.test(target)) {
    // A URL ending in .png is an image wherever it is hosted; anything else on
    // the web is a page, including a .pdf, which we will not fetch to preview.
    return media() ?? "webpage";
  }

  // A drive letter is a path, not a scheme. Everything else with a scheme —
  // mailto:, data:, tel: — is not ours.
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) && !/^[a-z]:[\\/]/i.test(target)) return null;

  return media() ?? (PDF_EXT.has(ext) ? "pdf" : "file");
}

// ---------------------------------------------------------------------------
// Scanning prose
// ---------------------------------------------------------------------------

/** Trailing characters that end a sentence rather than a path. */
const TRAILING = /[.,;:!?'"`)\]}>]+$/;
/** Leading characters that open a quotation rather than a path. */
const LEADING = /^[('"`[{<]+/;

/** Characters no filesystem we serve will accept, and prose is full of. */
const ILLEGAL = /["<>|*?\u0000-\u001f]/;

/**
 * Trim the punctuation a sentence wraps around a path. Closing brackets are
 * only dropped when unbalanced, so `src/(gen)` survives while `(src/gen)` does
 * not keep its parenthesis.
 */
function trimPunctuation(raw: string): { target: string; offset: number } {
  let target = raw;
  let offset = 0;

  const lead = LEADING.exec(target);
  if (lead) {
    offset = lead[0].length;
    target = target.slice(offset);
  }

  for (;;) {
    const tail = TRAILING.exec(target);
    if (!tail) break;
    // Keep a closing bracket that has an opener inside the candidate itself.
    const last = target[target.length - 1] ?? "";
    const opener = last === ")" ? "(" : last === "]" ? "[" : last === "}" ? "{" : null;
    if (opener && count(target, opener) > count(target, last)) break;
    const trimmed = target.slice(0, target.length - 1);
    if (!trimmed) break;
    target = trimmed;
  }

  return { target, offset };
}

function count(text: string, char: string): number {
  let n = 0;
  for (const c of text) if (c === char) n++;
  return n;
}

/**
 * Whether a whitespace-delimited token is worth asking the server about.
 *
 * Deliberately permissive — resolution is the real filter — but it still has to
 * reject the shapes that would otherwise flood every batch: prose containing a
 * slash (`and/or`), version ranges, dates, and decimals.
 */
export function isPathLike(token: string): boolean {
  if (!token || token.length > 260) return false;
  if (ILLEGAL.test(token)) return false;
  if (/^https?:\/\//i.test(token)) return false;
  if (/\s/.test(token)) return false;

  const hasSeparator = token.includes("/") || token.includes("\\");
  const ext = extensionOf(token);
  const hasExtension = /^\.[a-z0-9]{1,8}$/.test(ext);
  if (!hasSeparator && !hasExtension) return false;

  // 24/7, 1/2, 2026/08/09, v1.2.3 — digits and separators only.
  if (/^[\d.,/\\v-]+$/i.test(token)) return false;

  // `/etc/hosts` and `and/or` are the same shape — two lowercase words around a
  // slash — so spelling alone cannot separate them. What can is an explicit
  // anchor: a leading separator, `./`, `../`, `~/`, or a drive letter. Nobody
  // writes prose that way, and it is how a path is written when it matters.
  const anchored = /^([/\\]|\.{1,2}[/\\]|~[/\\]|[a-z]:[\\/])/i.test(token);
  const segments = token.split(/[/\\]+/).filter(Boolean);

  if (hasExtension) return true;

  // `/new`, `/settings`, `/theme` — this app's own slash commands, which appear
  // in its transcripts constantly and are anchored by the same leading slash a
  // path uses. One segment and no extension after an anchor is a command or a
  // route far more often than it is a directory anyone meant to open.
  if (anchored) return segments.length >= 2;

  if (segments.length < 2) return false;
  // Prose joined by a slash is two words, whichever case they are written in.
  if (segments.length === 2 && segments.every((s) => /^[a-z]+$/i.test(s))) return false;

  return true;
}

/**
 * Every reference in a run of plain prose, in order and non-overlapping.
 *
 * URLs are matched first because they contain slashes and dots and would
 * otherwise be shredded by the path rules.
 */
export function findReferences(text: string): Reference[] {
  const found: Reference[] = [];

  const URL = /https?:\/\/[^\s<>"'`)\]}]+/gi;
  const taken: Array<[number, number]> = [];
  for (const match of text.matchAll(URL)) {
    const start = match.index;
    const { target } = trimPunctuation(match[0]);
    if (!target) continue;
    const kind = classifyTarget(target);
    if (!kind) continue;
    found.push({ kind, target, start, end: start + target.length });
    taken.push([start, start + target.length]);
  }

  const TOKEN = /\S+/g;
  for (const match of text.matchAll(TOKEN)) {
    const at = match.index;
    if (taken.some(([s, e]) => at < e && at + match[0].length > s)) continue;

    const { target, offset } = trimPunctuation(match[0]);
    if (!isPathLike(target)) continue;
    const kind = classifyTarget(target);
    if (!kind) continue;
    found.push({ kind, target, start: at + offset, end: at + offset + target.length });
  }

  return found.sort((a, b) => a.start - b.start);
}

/** Cut a string into literal text and references, ready to render in order. */
export function segment(text: string): Segment[] {
  const references = findReferences(text);
  if (references.length === 0) return [{ text }];

  const out: Segment[] = [];
  let at = 0;
  for (const reference of references) {
    if (reference.start > at) out.push({ text: text.slice(at, reference.start) });
    out.push({ reference });
    at = reference.end;
  }
  if (at < text.length) out.push({ text: text.slice(at) });
  return out;
}
