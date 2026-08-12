import { For, Show } from "solid-js";
import { openFile, state } from "../store.ts";
import { Icon } from "./ui/icon.tsx";

/** Comment navigator: every anchor the human has left, across the workspace. */
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

                </li>
              );
            }}
          </For>
        </ul>
      </div>
    </Show>
  );
}
