import { For, Show } from "solid-js";
import { attachComment, openFile, resolveComment, state } from "../store.ts";
import { commentLabel } from "../lib/comments.ts";
import { Icon } from "./ui/icon.tsx";

/**
 * Comment navigator: every anchor the human has left, across the workspace.
 *
 * Three things to do with one, because a comment is written before it is sent
 * (§18) and need not be closed by the agent (§22): go to the line it is on, park
 * it in the composer to hand over now, or call it finished. Everything here is
 * unsent or unfinished — resolved ones leave the list — so the second is the only
 * way back to one the reader deleted the pill for, and the third is how a note
 * that no longer needs anyone leaves.
 */
export function CommentList() {
  const open = () => state.comments.filter((c) => c.status !== "resolved");

  return (
    <Show when={open().length > 0}>
      <div data-slot="sidebar-section">
        <div data-slot="section-title">Comments · {open().length}</div>
        <ul class="flex flex-col gap-0.5">
          <For each={open()}>
            {(comment) => {
              const name = comment.path.split(/[\\/]/).pop() ?? comment.path;
              return (
                <li data-slot="comment-row" data-status={comment.status}>
                  <button type="button" data-slot="comment-open" onClick={() => void openFile(comment.path)}>
                    <span data-slot="comment-file">
                      <Icon name="comment" size={12} />
                      {name}
                      <Show when={comment.lineStart != null}>
                        <span class="text-v2-text-text-faint">:{comment.lineStart}</span>
                      </Show>
                    </span>
                    <span data-slot="comment-body">{comment.body}</span>
                  </button>

                  <button
                    type="button"
                    data-slot="comment-attach"
                    title={`Put ${commentLabel(comment)} in the composer`}
                    aria-label={`Put ${commentLabel(comment)} in the composer`}
                    onClick={() => attachComment(comment)}
                  >
                    <Icon name="arrow-up" size={11} />
                  </button>

                  <button
                    type="button"
                    data-slot="comment-resolve"
                    title={`Resolve ${commentLabel(comment)}`}
                    aria-label={`Resolve ${commentLabel(comment)}`}
                    onClick={() => void resolveComment(comment.id)}
                  >
                    <Icon name="check" size={12} />
                  </button>
                </li>
              );
            }}
          </For>
        </ul>
      </div>
    </Show>
  );
}
