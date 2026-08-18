/**
 * What the composer is holding, as a document rather than a string (§57).
 *
 * A mention is an atomic thing that happens to be spelled `@something`. Kept as
 * a string it has to be re-found by pattern every time it is drawn, deleted or
 * sent — and worse, its identity has to be guessed back out of its label, which
 * cannot be done: two files are called `notes.md`, and `@sarah` does not say
 * which Sarah. So the draft is a list of nodes, each mention carrying the id it
 * stands for, and text is *derived* from it. Structured to text is safe;
 * text to structured is not.
 *
 * The transcript still works from text, because text is all a stored message
 * has. That is the right trade there and the wrong one here: the composer knows
 * what was picked, and should not have to rediscover it.
 */

export type DraftNode =
  | { type: "text"; text: string }
  | {
      type: "mention";
      /** A memory subject (§52), a file (§51), or a file comment (§18). */
      kind: "subject" | "file" | "comment";
      /** The slug, the absolute path, or the comment's id — whatever the agent needs. */
      id: string;
      /** What the reader sees: a name, a filename, or `file:line`. */
      label: string;
    };

export type Draft = DraftNode[];

/** Adjacent text merged, empties dropped, so equal drafts compare equal. */
export function normalize(draft: Draft): Draft {
  const out: Draft = [];
  for (const node of draft) {
    if (node.type === "text") {
      if (node.text === "") continue;
      const last = out[out.length - 1];
      if (last?.type === "text") {
        last.text += node.text;
        continue;
      }
      out.push({ ...node });
      continue;
    }
    out.push({ ...node });
  }
  return out;
}

/**
 * What a pill draws, which is not always what it reads as.
 *
 * A name is spelled the way it was typed, `@` included. A comment is not
 * something anyone types — it is a place in a file — so it carries no sigil at
 * all, and what marks it out as a comment is the icon the field puts in front of
 * it, drawn like every other icon in the app rather than written into the text.
 */
export function draftLabel(node: Extract<DraftNode, { type: "mention" }>): string {
  return node.kind === "comment" ? node.label : `@${node.label}`;
}

/**
 * What the draft reads as — `@notes.md`, `@Sarah`.
 *
 * The transcript shows this, and it is what goes back into the field when a
 * message is rewound. It is a view, not the record.
 *
 * A comment pill reads as nothing at all. It stands for a comment the server
 * already holds, and both readings of that — the card the transcript shows and
 * the block the model gets — are composed there from the stored row (§19). All
 * this side carries is the id, so writing the label in would put the location
 * in the message twice: once inline, once in the card underneath it.
 */
export function draftText(draft: Draft): string {
  return draft
    .map((node) => (node.type === "text" ? node.text : node.kind === "comment" ? "" : `@${node.label}`))
    .join("");
}

/**
 * What the agent is given.
 *
 * A file becomes the path it stands for, which is the thing that can be opened
 * and the thing its comments are matched against (§16). A subject stays `@slug`
 * — the server expands those itself, and has since before this existed.
 */
export function draftForModel(draft: Draft): string {
  return draft
    .map((node) => {
      if (node.type === "text") return node.text;
      if (node.kind === "comment") return "";
      return node.kind === "file" ? node.id : `@${node.id}`;
    })
    .join("");
}

/**
 * The comments the draft carries, in the order their pills sit in it (§18).
 *
 * Sent beside the text rather than woven into it: the agent's copy of a comment
 * is a structured block built from the row the server already has, and the id
 * is the only part of that this side is entitled to know.
 */
export function draftComments(draft: Draft): string[] {
  const ids: string[] = [];
  for (const node of draft) if (node.type === "mention" && node.kind === "comment") ids.push(node.id);
  return ids;
}

/** Nothing typed, and nothing mentioned — a parked comment counts as mentioned. */
export function draftIsEmpty(draft: Draft): boolean {
  return draftText(draft).trim() === "" && draftComments(draft).length === 0;
}

/** A draft holding one run of text, which is most of them. */
export function textDraft(text: string): Draft {
  return text === "" ? [] : [{ type: "text", text }];
}

/** The clipboard type that carries mentions between Picone's own fields. */
export const DRAFT_MIME = "application/x-picone-draft";

export function serializeDraft(draft: Draft): string {
  return JSON.stringify(normalize(draft));
}

/**
 * Read a draft back off the clipboard.
 *
 * Anything unrecognised is refused rather than half-trusted: the fallback is
 * `text/plain`, which is always there and always safe.
 */
export function parseDraft(raw: string): Draft | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const draft: Draft = [];
    for (const node of parsed) {
      if (!node || typeof node !== "object") return null;
      const value = node as Record<string, unknown>;
      if (value.type === "text" && typeof value.text === "string") {
        draft.push({ type: "text", text: value.text });
        continue;
      }
      if (
        value.type === "mention" &&
        (value.kind === "subject" || value.kind === "file" || value.kind === "comment") &&
        typeof value.id === "string" &&
        typeof value.label === "string"
      ) {
        draft.push({ type: "mention", kind: value.kind, id: value.id, label: value.label });
        continue;
      }
      return null;
    }
    return normalize(draft);
  } catch {
    return null;
  }
}
