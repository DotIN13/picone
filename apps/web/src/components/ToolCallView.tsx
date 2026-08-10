import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";
import type { ToolCall } from "@picone/protocol";
import { surfaceOf, openFile } from "../store.ts";
import { asTodoDetails, describeDetails, todoProgress, type DetailNode, type TodoTask } from "../lib/tool-details.ts";
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
  /*
   * Collapsed unless an extension has asked otherwise (§55). `setToolsExpanded`
   * is a global preference, so a change to it re-syncs every call — that is the
   * point of the call — while a toggle in between stays a local decision.
   */
  const [open, setOpen] = createSignal(surfaceOf().toolsExpanded ?? false);
  createEffect(() => setOpen(surfaceOf().toolsExpanded ?? false));

  const path = () => (FILE_TOOLS.has(props.toolCall.name) ? extractPath(props.toolCall.args) : null);
  /** A task list an extension returned, if that is what its result was (§56). */
  const todo = () => asTodoDetails(props.toolCall.details);
  const structured = () => describeDetails(props.toolCall.details);
  const hasDetail = () =>
    Boolean(props.toolCall.output || props.toolCall.patch || todo() || structured().length > 0);

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
          <Show when={todo()}>
            {(list) => {
              const progress = () => todoProgress(list().tasks);
              return (
                <span data-slot="toolcall-count">
                  {progress().done}/{progress().total}
                </span>
              );
            }}
          </Show>
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
        {/*
          A task list is drawn rather than printed (§56). It comes before the
          text output because it *is* the output — the prose beside it repeats
          the same thing for the model's benefit.
        */}
        <Show when={todo()}>{(list) => <TodoList tasks={list().tasks} />}</Show>

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

        {/*
          Anything else a tool returned, as JSON. Not a guess at a layout: it is
          shown only once someone has expanded the call, which is to say once
          they have asked to read it.
        */}
        <Show when={structured().length > 0}>
          <div data-slot="toolcall-details">
            <For each={structured()}>{(node) => <DetailView node={node} />}</For>
          </div>
        </Show>
      </Show>
    </div>
  );
}

/**
 * One piece of a tool's structured result, laid out by its shape (DESIGN §56).
 *
 * Shape rather than name, so an extension we have never heard of still gets a
 * table when it returns a list of records. Only what will not fit a shape is
 * printed as JSON.
 */
function DetailView(props: { node: DetailNode }) {
  return (
    <Switch>
      <Match when={props.node.kind === "field" ? props.node : null}>
        {(node) => (
          <div data-slot="detail-field">
            <span data-slot="detail-key">{node().key}</span>
            <span data-slot="detail-value">{node().value}</span>
          </div>
        )}
      </Match>

      <Match when={props.node.kind === "list" ? props.node : null}>
        {(node) => (
          <div data-slot="detail-block">
            <span data-slot="detail-key">{node().key}</span>
            <ul data-slot="detail-list">
              <For each={node().items}>{(item) => <li>{item}</li>}</For>
            </ul>
          </div>
        )}
      </Match>

      <Match when={props.node.kind === "table" ? props.node : null}>
        {(node) => (
          <div data-slot="detail-block">
            <Show when={node().key}>
              <span data-slot="detail-key">{node().key}</span>
            </Show>
            <table data-slot="detail-table">
              <thead>
                <tr>
                  <For each={node().columns}>{(column) => <th>{column}</th>}</For>
                </tr>
              </thead>
              <tbody>
                <For each={node().rows}>
                  {(row) => (
                    <tr>
                      <For each={row}>{(cell) => <td>{cell}</td>}</For>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </div>
        )}
      </Match>

      <Match when={props.node.kind === "json" ? props.node : null}>
        {(node) => (
          <div data-slot="detail-block">
            <Show when={node().key}>
              <span data-slot="detail-key">{node().key}</span>
            </Show>
            <pre data-slot="detail-json">{node().text}</pre>
          </div>
        )}
      </Match>
    </Switch>
  );
}

/**
 * A task list, drawn (DESIGN §56).
 *
 * The same information the extension renders as ASCII in its own panel, except
 * that here it can be real text at the reading size, with status carried by
 * colour and weight rather than by box-drawing characters.
 */
function TodoList(props: { tasks: TodoTask[] }) {
  const visible = () => todoProgress(props.tasks).visible;
  return (
    <ul data-slot="todo-list">
      <For each={visible()}>
        {(task) => (
          <li data-slot="todo-item" data-status={task.status}>
            <span data-slot="todo-glyph">{TODO_GLYPH[task.status]}</span>
            <span data-slot="todo-subject">{task.subject}</span>
            <Show when={task.blockedBy?.length}>
              <span data-slot="todo-blocked">blocked by {task.blockedBy!.join(", ")}</span>
            </Show>
          </li>
        )}
      </For>
    </ul>
  );
}

/** Matching the glyphs the extension uses in the terminal, so the two agree. */
const TODO_GLYPH: Record<string, string> = {
  pending: "○",
  in_progress: "◐",
  completed: "✓",
  deleted: "✗",
};

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
