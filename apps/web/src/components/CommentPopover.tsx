import { Show, createEffect, createSignal } from "solid-js";
import { state } from "../store.ts";
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
  const style = () =>
    state.compact
      ? undefined
      : {
          left: `${Math.max(12, Math.min(props.selection.x, window.innerWidth - 420))}px`,
          top: `${Math.min(props.selection.y + 8, window.innerHeight - (composing() ? 260 : 60))}px`,
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
