import { For, Show, createSignal } from "solid-js";
import type { ToolCall } from "@picone/protocol";
import { openFile } from "../store.ts";
import { Icon } from "./ui/icon.tsx";
import { Spinner } from "./ui/primitives.tsx";

const FILE_TOOLS = new Set(["read", "write", "edit", "ls"]);

/**
 * One tool call, as a line rather than a card.
 *
 * A turn can make a dozen of these, and boxing each one turns the transcript
 * into a wall of containers with the conversation lost between them. So they
 * read as a log: a status glyph, the tool, its subject, and nothing else until
 * asked. Success is deliberately the quietest state — what wants finding in a
 * long run is the one call that failed.
 */
export function ToolCallView(props: { toolCall: ToolCall }) {
  const [open, setOpen] = createSignal(false);

  const path = () => (FILE_TOOLS.has(props.toolCall.name) ? extractPath(props.toolCall.args) : null);
  const hasDetail = () => Boolean(props.toolCall.output || props.toolCall.patch);

  return (
    <div data-component="toolcall" data-status={props.toolCall.status}>
      <div data-slot="toolcall-head">
        <button
          type="button"
          data-slot="toolcall-row"
          disabled={!hasDetail()}
          onClick={() => setOpen((v) => !v)}
          title={hasDetail() ? (open() ? "Hide output" : "Show output") : undefined}
        >
          <span data-slot="toolcall-status">
            <StatusGlyph status={props.toolCall.status} />
          </span>
          <span data-slot="toolcall-name">{props.toolCall.name}</span>
          <span data-slot="toolcall-title">{props.toolCall.title}</span>
          <Show when={hasDetail()}>
            <Icon name={open() ? "chevron-up" : "chevron-down"} size={12} class="shrink-0 opacity-50" />
          </Show>
        </button>

        <Show when={path()}>
          {(filePath) => (
            // The agent's work stays put; opening a file is the user's choice (DESIGN §14).
            <button type="button" data-slot="toolcall-open" onClick={() => void openFile(filePath())}>
              Open
            </button>
          )}
        </Show>
      </div>

      <Show when={open()}>
        <Show
          when={props.toolCall.patch}
          fallback={
            <Show when={props.toolCall.output}>
              <pre data-slot="toolcall-output">{props.toolCall.output}</pre>
            </Show>
          }
        >
          {(patch) => (
            <pre data-slot="toolcall-patch">
              <For each={patch().split("\n")}>
                {(line) => (
                  <span data-slot="patch-line" data-kind={patchKind(line)}>
                    {line}
                    {"\n"}
                  </span>
                )}
              </For>
            </pre>
          )}
        </Show>
      </Show>
    </div>
  );
}

/**
 * One glyph, same width in every state, so the names below it stay in a column.
 *
 * Not called `Switch`. Solid's JSX compiler treats `Switch` as control flow and
 * compiles `<Switch>` into the built-in whatever is in scope, so a local
 * component of that name is read as a `Switch` whose children should be
 * `Match` elements — and it crashed on `mp.when` the moment a tool call
 * rendered, taking the transcript with it.
 */
function StatusGlyph(props: { status: ToolCall["status"] }) {
  return (
    <Show when={props.status !== "running"} fallback={<Spinner size={9} />}>
      <Show when={props.status !== "ok"} fallback={<span data-slot="toolcall-dot" />}>
        <Icon name={props.status === "blocked" ? "minus" : "alert"} size={11} />
      </Show>
    </Show>
  );
}

function patchKind(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return "add";
  if (line.startsWith("-") && !line.startsWith("---")) return "del";
  if (line.startsWith("@@")) return "hunk";
  return "context";
}

function extractPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const value = (args as { path?: unknown }).path;
  return typeof value === "string" ? value : null;
}
