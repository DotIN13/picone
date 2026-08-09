import { For, Show, onCleanup, onMount } from "solid-js";
import type { FileComment } from "@picone/protocol";
import { Markdown } from "./Markdown.tsx";
import { findLineRange } from "../lib/selection.ts";
import type { Selection } from "./CodeView.tsx";
import { LineComment } from "./ui/line-comment.tsx";
import { Button } from "./ui/button.tsx";
import { Tag } from "./ui/primitives.tsx";

export interface MarkdownViewProps {
  content: string;
  comments: FileComment[];
  onSelect: (selection: Selection | null) => void;
  onResolveComment: (id: string) => void;
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

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const range = findLineRange(props.content, text);
    props.onSelect({
      text,
      lineStart: range?.lineStart ?? 0,
      lineEnd: range?.lineEnd ?? 0,
      x: rect.left,
      y: rect.bottom,
    });
  };

  onMount(() => {
    const onPointerDown = (event: MouseEvent) => {
      inPopover = Boolean((event.target as HTMLElement | null)?.closest?.("[data-component='comment-popover']"));
    };
    document.addEventListener("mousedown", onPointerDown, true);
    document.addEventListener("selectionchange", readSelection);
    onCleanup(() => {
      document.removeEventListener("mousedown", onPointerDown, true);
      document.removeEventListener("selectionchange", readSelection);
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
                      <Show when={comment.status === "addressed"}>
                        <Tag tone="success">addressed</Tag>
                      </Show>
                    </>
                  }
                  actions={
                    <Button size="small" variant="ghost" onClick={() => props.onResolveComment(comment.id)}>
                      Resolve
                    </Button>
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
