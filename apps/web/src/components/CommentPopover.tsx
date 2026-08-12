import { Show, createEffect, createSignal } from "solid-js";
import { state } from "../store.ts";
import { effectiveZoom } from "../lib/app-settings.ts";
import type { Selection } from "./CodeView.tsx";
import { Button } from "./ui/button.tsx";
import { LineCommentEditor } from "./ui/line-comment.tsx";

export interface CommentPopoverProps {
  selection: Selection;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

/**
 * Select text → [Comment] → inline composer (DESIGN §18).
 * Two steps so a stray selection never opens a text box in the user's face.
 */
export function CommentPopover(props: CommentPopoverProps) {
  const [composing, setComposing] = createSignal(false);
  const [body, setBody] = createSignal("");

  createEffect(() => {
    // Reset whenever the anchor changes.
    props.selection.text;
    props.selection.lineStart;
    setComposing(false);
    setBody("");
  });

  /**
   * On a phone the composer would collide with the native selection handles and
   * the keyboard, so it docks to the bottom instead of floating at the caret.
   */
  const style = () => {
    if (state.compact) return undefined;

    /*
     * The selection is measured in viewport pixels and this box is positioned
     * inside the zoomed tree, so the two are not the same units: at 143% an
     * untranslated coordinate put the popover 43% further right than the words
     * it belongs to, and off the edge entirely near the right of a wide window.
     * Dividing converts one to the other; the bounds are converted with it, or
     * the clamp would be measuring a different viewport from the value.
     */
    const zoom = effectiveZoom(state.app.appearance, state.compact);
    const width = window.innerWidth / zoom;
    const height = window.innerHeight / zoom;
    const left = `${Math.max(12, Math.min(props.selection.x / zoom, width - 420))}px`;

    const top = props.selection.y / zoom;
    const bottom = props.selection.bottom / zoom;
    const needed = composing() ? 260 : 60;

    /*
     * Above the selection, its top-left corner as the anchor — the words you
     * are commenting on stay in view under it, which is the point. `-100%`
     * because the height is not known until it has rendered.
     *
     * Below only when there is no room up there, and against the *bottom* of
     * the selection so it still does not sit on top of the text.
     */
    return top - needed > 12
      ? { left, top: `${top - 8}px`, transform: "translateY(-100%)" }
      : { left, top: `${Math.min(bottom + 8, height - needed)}px` };
  };

  const anchorLabel = () => {
    const { lineStart, lineEnd, text } = props.selection;
    const where =
      lineStart > 0 ? (lineStart === lineEnd ? `line ${lineStart}` : `lines ${lineStart}–${lineEnd}`) : "selection";
    return `On ${where} · “${text.length > 90 ? `${text.slice(0, 89)}…` : text}”`;
  };

  return (
    <div
      data-component="comment-popover"
      data-composing={composing() ? "" : undefined}
      data-docked={state.compact ? "" : undefined}
      style={style()}
    >
      <Show
        when={composing()}
        fallback={
          <Button size="small" variant="contrast" icon="comment" onClick={() => setComposing(true)}>
            Comment
          </Button>
        }
      >
        <LineCommentEditor
          value={body()}
          onInput={setBody}
          onCancel={props.onCancel}
          onSubmit={(value) => {
            props.onSubmit(value);
            setBody("");
            setComposing(false);
          }}
          selection={anchorLabel()}
        />
      </Show>
    </div>
  );
}
