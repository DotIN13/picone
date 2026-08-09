import { For, Show, createSignal } from "solid-js";
import type { ToolCall } from "@picone/protocol";
import { openFile } from "../store.ts";
import { Icon } from "./ui/icon.tsx";
import { Spinner } from "./ui/primitives.tsx";

const FILE_TOOLS = new Set(["read", "write", "edit", "ls"]);

export function ToolCallView(props: { toolCall: ToolCall }) {
  const [open, setOpen] = createSignal(false);

  const path = () => (FILE_TOOLS.has(props.toolCall.name) ? extractPath(props.toolCall.args) : null);
  const hasDetail = () => Boolean(props.toolCall.output || props.toolCall.patch);

  return (
    <div data-component="toolcall" data-status={props.toolCall.status}>
      <div data-slot="toolcall-head">
        <span data-slot="toolcall-name">{props.toolCall.name}</span>
        <button
          type="button"
          data-slot="toolcall-title"
          disabled={!hasDetail()}
          onClick={() => setOpen((v) => !v)}
          title={hasDetail() ? "Show output" : undefined}
        >
          {props.toolCall.title}
        </button>
        <Show when={props.toolCall.status === "running"}>
          <Spinner />
        </Show>
        <Show when={hasDetail()}>
          <Icon name={open() ? "chevron-up" : "chevron-down"} size={12} class="text-v2-icon-icon-muted" />
        </Show>
        <Show when={path()}>
          {(filePath) => (
            // The agent's work stays put; opening a file is the user's choice (DESIGN §14).
            <button type="button" data-slot="toolcall-open" onClick={() => void openFile(filePath())}>
              Open file
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
