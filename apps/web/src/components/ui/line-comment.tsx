import { Show, onMount, type JSX } from "solid-js";
import type { CommentStatus } from "@picone/protocol";
import { Button } from "./button.tsx";

export interface LineCommentProps {
  comment: JSX.Element;
  /** Line / selection context, e.g. "Comment on line 40". */
  selection: JSX.Element;
  actions?: JSX.Element;
  status?: CommentStatus;
}

/** Display card for an existing comment — opencode's `line-comment-v2`, display variant. */
export function LineComment(props: LineCommentProps) {
  return (
    <div data-component="line-comment" data-variant="display" data-status={props.status ?? "open"}>
      <div data-slot="line-comment-shell">
        <div data-slot="line-comment-column">
          <div data-slot="line-comment-text">{props.comment}</div>
          <div data-slot="line-comment-meta">{props.selection}</div>
        </div>
        <Show when={props.actions}>{(actions) => <div data-slot="line-comment-tools">{actions()}</div>}</Show>
      </div>
    </div>
  );
}

export interface LineCommentEditorProps {
  heading?: string;
  value: string;
  onInput: (value: string) => void;
  onCancel: () => void;
  onSubmit: (value: string) => void;
  selection: JSX.Element;
  placeholder?: string;
  autofocus?: boolean;
}

/** Composer for a new comment — the editor variant of the same component. */
export function LineCommentEditor(props: LineCommentEditorProps) {
  let textarea: HTMLTextAreaElement | undefined;

  const canSubmit = () => props.value.trim().length > 0;
  const submit = () => {
    const value = props.value.trim();
    if (value) props.onSubmit(value);
  };

  onMount(() => {
    if (props.autofocus === false) return;
    requestAnimationFrame(() => textarea?.focus());
  });

  return (
    <div data-component="line-comment" data-variant="editor">
      <div data-slot="line-comment-shell">
        <div data-slot="line-comment-field">
          <div data-slot="line-comment-label">{props.heading ?? "Comment"}</div>
          <textarea
            ref={textarea}
            data-slot="line-comment-textarea"
            rows={3}
            placeholder={props.placeholder ?? "Leave a comment for the agent…"}
            value={props.value}
            onInput={(event) => props.onInput(event.currentTarget.value)}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Escape") {
                event.preventDefault();
                props.onCancel();
                return;
              }
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div data-slot="line-comment-footer">
          <div data-slot="line-comment-footer-meta">{props.selection}</div>
          <div data-slot="line-comment-footer-actions">
            <Button type="button" size="normal" variant="neutral" onClick={() => props.onCancel()}>
              Cancel
            </Button>
            <Button type="button" size="normal" variant="contrast" disabled={!canSubmit()} onClick={submit}>
              Comment
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
