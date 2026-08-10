import { For, Show } from "solid-js";
import type { MemorySubject } from "@picone/protocol";
import { openFile, state } from "../store.ts";

/**
 * A user message, with `@subject` shown as a pill (DESIGN §52).
 *
 * User messages are not markdown — they are displayed as typed, deliberately —
 * so mentions get their own small pass rather than going through the renderer
 * in §51. It is the same idea: the text is the source of truth, and the pill is
 * a view of it. A mention that no longer resolves stays the words the user
 * typed, which is what makes it safe to store mentions as plain text.
 */

/** Matched exactly as the server matches them, so the two never disagree. */
const MENTION = /(^|[\s([{"'])@([a-z0-9][a-z0-9._-]*)/gi;

type Part = { text: string } | { subject: MemorySubject; raw: string };

export function splitMentions(text: string, subjects: MemorySubject[]): Part[] {
  const bySlug = new Map(subjects.map((s) => [s.slug.toLowerCase(), s]));
  const parts: Part[] = [];
  let at = 0;

  for (const match of text.matchAll(MENTION)) {
    const lead = match[1] ?? "";
    const slug = (match[2] ?? "").replace(/[.]+$/, "");
    const subject = bySlug.get(slug.toLowerCase());
    if (!subject) continue;

    const start = (match.index ?? 0) + lead.length;
    if (start > at) parts.push({ text: text.slice(at, start) });
    parts.push({ subject, raw: `@${slug}` });
    at = start + slug.length + 1;
  }

  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts.length > 0 ? parts : [{ text }];
}

export function MentionText(props: { text: string }) {
  const parts = () => splitMentions(props.text, state.memorySubjects);

  return (
    <For each={parts()}>
      {(part) => (
        <Show when={"subject" in part ? part : null} fallback={<>{"text" in part ? part.text : null}</>}>
          {(hit) => (
            /*
              A span, not a button. Blink coerces `<button>` to inline-block
              whatever the stylesheet says, and an inline-block rides above the
              text beside it. A mention is a name inside a sentence, so it has
              to be a genuinely inline box — which means carrying the button's
              keyboard behaviour by hand.
            */
            <span
              data-component="mention-pill"
              role="button"
              tabindex={0}
              title={hit().subject.path}
              onClick={() => void openFile(hit().subject.path)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                void openFile(hit().subject.path);
              }}
            >
              @{hit().subject.name}
            </span>
          )}
        </Show>
      )}
    </For>
  );
}
