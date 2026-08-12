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
      /** A memory subject (§52), or a file (§51). */
      kind: "subject" | "file";
      /** The slug, or the absolute path — whatever the agent needs. */
      id: string;
      /** What the reader sees: a name, or a filename. */
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
 * What the draft reads as — `@notes.md`, `@Sarah`.
 *
 * The transcript shows this, and it is what goes back into the field when a
 * message is rewound. It is a view, not the record.
 */
export function draftText(draft: Draft): string {
  return draft.map((node) => (node.type === "text" ? node.text : `@${node.label}`)).join("");
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
      return node.kind === "file" ? node.id : `@${node.id}`;
    })
    .join("");
}

/** Nothing typed, and nothing mentioned. */
export function draftIsEmpty(draft: Draft): boolean {
  return draftText(draft).trim() === "";
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
        (value.kind === "subject" || value.kind === "file") &&
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
