import { Show, createMemo, createSignal } from "solid-js";
import { addComment, reloadFile, setCommentStatus, state, toggleMarkdownSource } from "../store.ts";
import { CodeView, type Selection } from "./CodeView.tsx";
import { MarkdownView } from "./MarkdownView.tsx";
import { CommentPopover } from "./CommentPopover.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { SegmentedControl, Tag } from "./ui/primitives.tsx";

export function FileTab(props: { path: string }) {
  const file = () => state.files[props.path];
  const comments = createMemo(() => state.comments.filter((c) => c.path === props.path));
  const [selection, setSelection] = createSignal<Selection | null>(null);

  const onResolveComment = (id: string) => void setCommentStatus(id, "resolved");

  const submitComment = (body: string) => {
    const current = selection();
    if (!current) return;
    addComment({
      path: props.path,
      matcher: current.text,
      lineStart: current.lineStart > 0 ? current.lineStart : undefined,
      lineEnd: current.lineEnd > 0 ? current.lineEnd : undefined,
      body,
    });
    setSelection(null);
    window.getSelection()?.removeAllRanges();
  };

  const content = () => file()?.content ?? null;
  const isMarkdown = () => content()?.kind === "markdown";
  const showSource = () => !isMarkdown() || (file()?.markdownSource ?? false);

  return (
    <div class="flex h-full min-h-0 flex-col">
      <Show
        when={content()}
        fallback={
          <div data-slot="file-placeholder">
            <Show when={file()?.error} fallback={<>Loading {props.path}…</>}>
              {(error) => (
                <span class="text-v2-state-fg-danger">
                  <Icon name="alert" size={14} /> {error()}
                </span>
              )}
            </Show>
          </div>
        }
      >
        {(fileContent) => (
          <>
            <div data-slot="file-toolbar">
              <Icon name="file" size={13} class="shrink-0 text-v2-icon-icon-muted" />
              <span data-slot="file-path" title={props.path}>
                {props.path}
              </span>
              <span class="flex-1" />
              <Show when={fileContent().truncated}>
                <Tag tone="warning">truncated</Tag>
              </Show>
              <Tag>read-only</Tag>
              <Show when={isMarkdown()}>
                <SegmentedControl
                  value={showSource() ? "source" : "rendered"}
                  onChange={() => toggleMarkdownSource(props.path)}
                  options={[
                    { value: "rendered", label: "Rendered" },
                    { value: "source", label: "Source" },
                  ]}
                />
              </Show>
              <IconButton icon="refresh" label="Reload from disk" onClick={() => void reloadFile(props.path)} />
            </div>

            {/* Never swap content under an active selection (DESIGN §24). */}
            <Show when={file()?.staleMtime !== null && file()?.staleMtime !== undefined}>
              <div data-slot="stale-banner">
                <Icon name="alert" size={13} />
                <span>This file changed on disk.</span>
                <Button size="small" variant="neutral" onClick={() => void reloadFile(props.path)}>
                  Refresh
                </Button>
              </div>
            </Show>

            <div class="min-h-0 flex-1 overflow-auto">
              <Show
                when={fileContent().kind !== "binary"}
                fallback={
                  <div data-slot="file-placeholder">
                    Binary file ({formatSize(fileContent().size)}) — nothing to show.
                  </div>
                }
              >
                <Show
                  when={showSource()}
                  fallback={
                    <MarkdownView
                      content={fileContent().content}
                      comments={comments()}
                      onSelect={setSelection}
                      onResolveComment={onResolveComment}
                    />
                  }
                >
                  <CodeView
                    content={fileContent().content}
                    language={fileContent().language}
                    comments={comments()}
                    onSelect={setSelection}
                    onResolveComment={onResolveComment}
                  />
                </Show>
              </Show>
            </div>
          </>
        )}
      </Show>

      <Show when={selection()}>
        {(current) => (
          <CommentPopover selection={current()} onSubmit={submitComment} onCancel={() => setSelection(null)} />
        )}
      </Show>
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
