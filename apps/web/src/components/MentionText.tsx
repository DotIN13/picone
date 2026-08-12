import { For, Show } from "solid-js";
import { openFile, state } from "../store.ts";
import { splitMentions, type MentionPill } from "../lib/mentions.ts";
export { pillRanges, splitMentions, type MentionPart, type MentionPill } from "../lib/mentions.ts";

/**
 * Mentions, and the pill each one is drawn as (DESIGN §51, §52).
 *
 * Two things can be mentioned — someone the memory directories know about, and
 * a file — and they are the same gesture with the same grammar: an `@` token
 * standing for something the agent should look at. So there is one split, one
 * pill, and one set of offsets, used by both the transcript and the composer.
 * Only what a pill *opens* differs, which is a prop rather than a second
 * component.
 *
 * A user message is displayed as typed, deliberately, so this is a small pass
 * of its own rather than the markdown renderer in §51. The text stays the
 * source of truth and the pill is a view of it: a mention that no longer
 * resolves is just the words that were typed, which is what makes it safe to
 * store mentions as plain text.
 */

/**
 * One pill, wherever it is being drawn.
 *
 * A span, not a button. Blink coerces `<button>` to inline-block whatever the
 * stylesheet says, and an inline-block rides above the text beside it. A
 * mention is a name inside a sentence, so it has to be a genuinely inline box —
 * which means carrying the button's keyboard behaviour by hand.
 *
 * `interactive` is off in the composer: there the pill is painted behind a
 * textarea, where nothing can be clicked and the caret is the only pointer.
 */
export function MentionPillView(props: { part: MentionPill; interactive?: boolean }) {
  const target = () => (props.part.kind === "subject" ? props.part.subject.path : null);
  const open = () => {
    const path = target();
    if (props.interactive && path) void openFile(path);
  };

  return (
    <span
      data-component="mention-pill"
      data-kind={props.part.kind}
      role={props.interactive && target() ? "button" : undefined}
      tabindex={props.interactive && target() ? 0 : undefined}
      title={props.interactive ? (target() ?? undefined) : undefined}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
    >
      {props.part.kind === "subject" ? `@${props.part.subject.name}` : props.part.raw}
    </span>
  );
}

export function MentionText(props: { text: string }) {
  const parts = () => splitMentions(props.text, state.memorySubjects);

  return (
    <For each={parts()}>
      {(part) => (
        <Show when={part.kind === "text" ? null : (part as MentionPill)} fallback={<>{"text" in part ? part.text : null}</>}>
          {(pill) => <MentionPillView part={pill()} interactive />}
        </Show>
      )}
    </For>
  );
}
