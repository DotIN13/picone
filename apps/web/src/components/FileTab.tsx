import { Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { addComment, reloadFile, resolveComment, setFileView, state, type FileView } from "../store.ts";
import { CodeView, type Selection } from "./CodeView.tsx";
import { findLineRange } from "../lib/selection.ts";
import { MarkdownView } from "./MarkdownView.tsx";
import { CommentPopover } from "./CommentPopover.tsx";
import { Button, IconButton } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { SegmentedControl, Tag } from "./ui/primitives.tsx";

/**
 * Where the preview frame points.
 *
 * Path-shaped, and forward slashes even on Windows, so that a relative
 * reference inside the page — `chart.png` beside a report — resolves to its
 * sibling and comes back through the same guard.
 */
function previewUrl(path: string, reloadedAt: number): string {
  const url = `/api/files/preview/${encodeURI(path.split("\\").join("/"))}`;
  // The frame fetched the document itself, so re-reading the file cannot reach
  // it. The counter in the query makes "Reload from disk" mean the preview too.
  return reloadedAt > 0 ? `${url}?reload=${reloadedAt}` : url;
}

export function FileTab(props: { path: string }) {
  const file = () => state.files[props.path];
  const comments = createMemo(() => state.comments.filter((c) => c.path === props.path));
  /** The memory root this file lives under, if it lives under one (§50). */
  const memoryRoot = createMemo(() =>
    state.workspace?.roots.find(
      (root) => root.kind === "memory" && props.path.toLowerCase().startsWith(root.path.toLowerCase()),
    ),
  );
  const [selection, setSelection] = createSignal<Selection | null>(null);
  let frame: HTMLIFrameElement | undefined;

  /*
   * The preview frame reporting what was highlighted in it (§17).
   *
   * Checked by *window*, not by origin: the frame is sandboxed into an opaque
   * origin, so `event.origin` is the string "null" and worth nothing. The
   * source window cannot be forged, and comparing it means a message from any
   * other frame or tab is ignored.
   */
  onMount(() => {
    const onMessage = (event: MessageEvent) => {
      if (!frame || event.source !== frame.contentWindow) return;
      const data = event.data as
        | { source?: string; text?: string; box?: { left: number; top: number; bottom: number } | null }
        | null;
      if (data?.source !== "picone-preview") return;

      const text = typeof data.text === "string" ? data.text.trim() : "";
      if (text.length < 2) {
        setSelection(null);
        return;
      }

      // The line is a hint recovered from the source we already hold; text the
      // page generated at runtime will not be in it, and that is allowed to
      // miss — the matcher is the anchor (§17).
      const range = findLineRange(content()?.content ?? "", text);

      /*
       * The frame reports the selection's rectangle in its own coordinates,
       * which are not the screen's: the interface zoom scales the frame, so a
       * point 300px down inside it paints 300 x zoom below the frame's top.
       * Scale, then add where the frame sits, and the result is in the viewport
       * pixels the popover expects. A page that reports no rectangle — or one
       * scrolled out of sight — falls back to the top of the frame.
       */
      const frameBox = frame.getBoundingClientRect();
      const zoom = frame.currentCSSZoom || 1;
      const inner = data.box;

      // No rectangle at all: the page reported a selection it cannot place.
      // Offer the action at the top of the frame rather than not at all.
      if (!inner) {
        setSelection({
          text,
          lineStart: range?.lineStart ?? 0,
          lineEnd: range?.lineEnd ?? 0,
          x: frameBox.left + 12,
          y: frameBox.top + 48,
          bottom: frameBox.top + 48,
        });
        return;
      }

      const top = inner.top * zoom;
      const bottom = inner.bottom * zoom;

      // Scrolled out of the frame: the words are not on screen, so neither is
      // the action. Without this it rode the scroll straight out of the frame
      // and sat over the toolbar.
      if (bottom <= 0 || top >= frameBox.height) {
        setSelection(null);
        return;
      }

      // Held inside the frame, so an action for a line at the very top does not
      // hang over the chrome above it.
      const clamp = (value: number) => Math.min(Math.max(value, 48), frameBox.height - 8);
      setSelection({
        text,
        lineStart: range?.lineStart ?? 0,
        lineEnd: range?.lineEnd ?? 0,
        x: frameBox.left + Math.max(inner.left * zoom, 8),
        y: frameBox.top + clamp(top),
        bottom: frameBox.top + clamp(bottom),
      });
    };
    /*
     * Pressing anywhere in the app dismisses it too.
     *
     * Events do not cross a frame boundary, so the bridge only ever hears about
     * clicks inside the page it is in. A press on the toolbar, the transcript
     * or the sidebar left the action floating over a frame nobody was looking
     * at any more — this is the other half of the same rule.
     */
    const dismiss = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest?.("[data-component='comment-popover']")) return;
      setSelection(null);
    };

    window.addEventListener("message", onMessage);
    document.addEventListener("mousedown", dismiss, true);
    onCleanup(() => {
      window.removeEventListener("message", onMessage);
      document.removeEventListener("mousedown", dismiss, true);
    });
  });

  // Changing what the tab shows, or reloading it, abandons the selection the
  // action belonged to.
  createEffect(() => {
    view();
    file()?.reloadedAt;
    setSelection(null);
  });


  const submitComment = (body: string) => {
    const current = selection();
    if (!current) return;
    // Saved and parked in the composer; sending it is a separate decision (§18).
    void addComment({
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
  const isHtml = () => content()?.kind === "html";
  /** Kinds with something to show as well as something to read (§24). */
  const rendered = () => content()?.kind === "markdown" || isHtml();
  /*
   * What each kind offers.
   *
   * HTML is shown as itself, in the sandboxed frame — there was a sanitized
   * rendering beside it once, from before the frame could be selected in, and
   * it only ever showed a lesser version of the same page. Markdown has no
   * frame: it is not a document a browser runs, and prose is the point.
   */
  const VIEWS = () => [
    ...(isHtml() ? [{ value: "preview", label: "Preview" }] : [{ value: "rendered", label: "Rendered" }]),
    { value: "source", label: "Source" },
  ];

  /** A kind with only one form is always showing it. */
  const fallback = (): FileView => (isHtml() ? "preview" : "rendered");
  const view = (): FileView => {
    if (!rendered()) return "source";
    const chosen = file()?.view ?? fallback();
    // A tab opened before HTML lost its rendered view still says "rendered".
    return chosen === "rendered" && isHtml() ? "preview" : chosen;
  };

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
              {/* Memory files look like any other markdown until you are told
                  otherwise, and where a note lives changes how you read it. */}
              <Show when={memoryRoot()}>
                {(root) => <Tag tone="magic">{root().writable ? "memory" : "memory · read-only"}</Tag>}
              </Show>
              <Tag>read-only</Tag>
              <Show when={rendered()}>
                <SegmentedControl
                  value={view()}
                  onChange={(next) => setFileView(props.path, next as FileView)}
                  options={VIEWS()}
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

            <div data-slot="file-body" class="min-h-0 flex-1 overflow-auto">
              <Show
                when={fileContent().kind !== "binary"}
                fallback={
                  <div data-slot="file-placeholder">
                    Binary file ({formatSize(fileContent().size)}) — nothing to show.
                  </div>
                }
              >
                <Switch>
                  <Match when={view() === "source"}>
                    <CodeView
                      content={fileContent().content}
                      language={fileContent().language}
                      comments={comments()}
                      onSelect={setSelection}
                      onResolve={(id) => void resolveComment(id)}
                    />
                  </Match>

                  {/*
                    The file as itself, scripts and all, in a frame that cannot
                    reach back: no `allow-same-origin`, and the response carries
                    its own `sandbox` policy. Keyed on the path so switching
                    tabs cannot leave the previous document in the frame.
                  */}
                  <Match when={view() === "preview"}>
                    <iframe
                      ref={frame}
                      data-slot="file-preview"
                      title={`Preview of ${props.path}`}
                      src={previewUrl(props.path, file()?.reloadedAt ?? 0)}
                      sandbox="allow-scripts"
                      referrerpolicy="no-referrer"
                    />
                  </Match>

                  <Match when={true}>
                    <MarkdownView content={fileContent().content} comments={comments()} onSelect={setSelection} />
                  </Match>
                </Switch>
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
