import { For, Show, onCleanup, onMount } from "solid-js";
import type { FileComment } from "@picone/protocol";
import { Markdown } from "./Markdown.tsx";
import { findLineRange } from "../lib/selection.ts";
import type { Selection } from "./CodeView.tsx";
import { LineComment } from "./ui/line-comment.tsx";
import { IconButton } from "./ui/button.tsx";
import { resolveComment } from "../store.ts";

export interface MarkdownViewProps {
  content: string;
  comments: FileComment[];
  onSelect: (selection: Selection | null) => void;
}

/**
 * Rendered markdown with selection-to-comment support. The DOM has no line
 * numbers, so line hints are recovered by locating the selected text in the
 * source — good enough, because the matcher is the real anchor (DESIGN §17).
 */
export function MarkdownView(props: MarkdownViewProps) {
  let host: HTMLDivElement | undefined;
  /** True while the pointer is interacting with the comment popover. */
  let inPopover = false;

  const readSelection = () => {
    // Clicking or typing in the popover collapses the document selection.
    // That must not be read as "the user deselected the text".
    if (inPopover || document.activeElement?.closest?.("[data-component='comment-popover']")) return;

    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || !host) {
      props.onSelect(null);
      return;
    }
    if (!host.contains(selection.anchorNode) || !host.contains(selection.focusNode)) {
      props.onSelect(null);
      return;
    }

    const text = selection.toString().trim();
    if (text.length < 2) {
      props.onSelect(null);
      return;
    }

    /*
     * The first line's rectangle, not the whole selection's.
     *
     * A range spanning several lines has a bounding box as wide as the widest
     * of them and starting at the leftmost — so a selection begun halfway
     * along a line would put the action out to the left of where it began.
     * The first client rect is the first line fragment, which is where the
     * selection actually starts.
     */
    const domRange = selection.getRangeAt(0);
    const rect = domRange.getClientRects()[0] ?? domRange.getBoundingClientRect();
    const range = findLineRange(props.content, text);
    props.onSelect({
      text,
      lineStart: range?.lineStart ?? 0,
      lineEnd: range?.lineEnd ?? 0,
      x: rect.left,
      y: rect.top,
      bottom: rect.bottom,
    });
  };

  onMount(() => {
    const onPointerDown = (event: MouseEvent) => {
      inPopover = Boolean((event.target as HTMLElement | null)?.closest?.("[data-component='comment-popover']"));
      // Pressing anywhere else dismisses immediately. Clicking on selected text
      // collapses it, and waiting for the release to notice left the action
      // hanging over a selection that had already gone.
      if (!inPopover) props.onSelect(null);
    };
    /*
     * On release, not on `selectionchange`.
     *
     * A drag fires that event for every character it passes over, so the
     * action appeared the moment the mouse moved and then chased the cursor
     * across the page. Waiting for the button to come up shows it once, where
     * the selection ended up.
     */
    /*
     * Read after the event rather than during it. Pressing inside an existing
     * selection does not collapse it on the spot — the browser waits to see
     * whether a drag is beginning and collapses on release, after this handler
     * would have run. Reading synchronously found the old selection still
     * there and put the action straight back up.
     */
    const readAfter = () => setTimeout(readSelection, 0);

    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("mouseup", readAfter);
    document.addEventListener("touchend", readAfter);
    // Shift-arrow selects without a pointer ever going down.
    document.addEventListener("keyup", readAfter);
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("mouseup", readAfter);
      document.removeEventListener("touchend", readAfter);
      document.removeEventListener("keyup", readAfter);
    });
  });

  const open = () => props.comments.filter((c) => c.status !== "resolved");

  return (
    <div data-slot="markdown-view" ref={host}>
      <Markdown text={props.content} />

      <Show when={open().length > 0}>
        <div data-slot="markdown-comments">
          <div data-slot="section-title">Comments on this file</div>
          <div class="flex flex-col gap-2">
            <For each={open()}>
              {(comment) => (
                <LineComment
                  status={comment.status}
                  comment={comment.body}
                  selection={
                    <>
                      <span>
                        {comment.lineStart ? `Comment on line ${comment.lineStart}` : "Comment on selection"} ·{" "}
                        <span class="italic">“{truncate(comment.matcher)}”</span>
                      </span>
                    </>
                  }
                  actions={
                    <IconButton
                      icon="check"
                      size="small"
                      variant="ghost-muted"
                      label={
                        comment.lineStart
                          ? `Resolve the comment on line ${comment.lineStart}`
                          : "Resolve the comment on this file"
                      }
                      onClick={() => void resolveComment(comment.id)}
                    />
                  }
                />
              )}
            </For>
          </div>
        </div>
      </Show>
    </div>
  );
}

function truncate(text: string, max = 100): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
