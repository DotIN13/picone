import type { MemorySubject } from "@picone/protocol";

/**
 * What an `@` token means, and where it sits (DESIGN §51, §52).
 *
 * Two things can be mentioned — someone the memory directories know about, and
 * a file — and they are the same gesture with the same grammar. One split
 * serves the transcript, the composer's pills and its atomic delete, so all
 * three agree by construction about where a mention starts and ends.
 *
 * Pure, and deliberately free of the store: the rules here are the part worth
 * testing, and a test should not have to stand up a browser to reach them.
 */

/** Every `@token`, wherever it sits. What counts as a mention is decided below. */
const MENTION = /(^|[\s\S])@([a-z0-9][a-z0-9._-]*)/gi;

/** The boundary the server requires before a subject mention, so the two agree. */
const OPENS = /[\s([{"']/;

/**
 * A token that names a file rather than a subject — `@report.html`.
 *
 * Recognised by shape, because that is all the transcript has: the message
 * stores what was typed, and the path it stood for went to the model.
 */
const FILE_TOKEN = /\.[a-z0-9]{1,12}$/i;

/**
 * What a file mention may not be, when it follows a word.
 *
 * A subject mention has to start a word — `mail@example` is an address, not a
 * name, and the server applies the same rule. A file is allowed to follow one,
 * because pasted text runs things together and `notes@report.md` is not an
 * address anyone has. The exception to the exception is the endings that are.
 */
const EMAIL_TLD = /\.(com|org|net|io|co|edu|gov|uk|de|fr|jp|cn|ru|me|dev|app|ai)$/i;

export type MentionPart =
  | { kind: "text"; text: string }
  | { kind: "subject"; raw: string; subject: MemorySubject }
  | { kind: "file"; raw: string };

/** The pill kinds, as opposed to the prose between them. */
export type MentionPill = Extract<MentionPart, { kind: "subject" | "file" }>;

export function splitMentions(text: string, subjects: MemorySubject[]): MentionPart[] {
  const bySlug = new Map(subjects.map((s) => [s.slug.toLowerCase(), s]));
  const parts: MentionPart[] = [];
  let at = 0;

  for (const match of text.matchAll(MENTION)) {
    const lead = match[1] ?? "";
    const slug = (match[2] ?? "").replace(/[.]+$/, "");
    const subject = bySlug.get(slug.toLowerCase());
    const file = !subject && FILE_TOKEN.test(slug) && !EMAIL_TLD.test(slug);
    if (!subject && !file) continue;

    // A subject must start a word; a file need not, so a mention survives being
    // pasted with no space in front of it.
    if (!(lead === "" || OPENS.test(lead)) && !file) continue;

    const start = (match.index ?? 0) + lead.length;
    if (start > at) parts.push({ kind: "text", text: text.slice(at, start) });
    parts.push(subject ? { kind: "subject", raw: `@${slug}`, subject } : { kind: "file", raw: `@${slug}` });
    at = start + slug.length + 1;
  }

  if (at < text.length) parts.push({ kind: "text", text: text.slice(at) });
  return parts.length > 0 ? parts : [{ kind: "text", text }];
}

/**
 * Where each pill sits in the text, as offsets.
 *
 * The composer needs this to treat one as a single thing: a pill is a name, and
 * a backspace at the end of a name means the name, not its last letter. Derived
 * from the same split that draws them, so what deletes atomically is exactly
 * what looks atomic — and it is the same for both kinds.
 */
export function pillRanges(text: string, subjects: MemorySubject[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let at = 0;
  for (const part of splitMentions(text, subjects)) {
    const length = part.kind === "text" ? part.text.length : part.raw.length;
    if (part.kind !== "text") ranges.push({ start: at, end: at + length });
    at += length;
  }
  return ranges;
}
