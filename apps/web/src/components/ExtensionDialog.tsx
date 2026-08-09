import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";
import { answerExtensionUi, state } from "../store.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Dialog } from "./ui/primitives.tsx";

/**
 * Renders the blocking half of Pi's extension UI surface: select, confirm,
 * input, and editor. One prompt is shown at a time; the rest queue behind it.
 */
export function ExtensionDialog() {
  const prompt = () => state.extensionPrompts[0];

  const [text, setText] = createSignal("");
  const [choice, setChoice] = createSignal(0);

  createEffect(() => {
    const current = prompt();
    if (!current) return;
    setText(current.method === "editor" ? (current.prefill ?? "") : "");
    setChoice(0);
  });

  const cancel = () => {
    const current = prompt();
    if (current) answerExtensionUi({ id: current.id, cancelled: true });
  };

  return (
    <Show when={prompt()}>
      {(current) => (
        <Dialog
          open
          onOpenChange={(open) => !open && cancel()}
          title={
            <span class="flex items-center gap-2">
              <Icon name="plug" size={14} class="text-v2-icon-icon-muted" />
              {current().title}
            </span>
          }
          description={current().method === "confirm" ? undefined : "Requested by a Pi extension"}
          width={current().method === "editor" ? "680px" : "460px"}
          footer={
            <Switch>
              <Match when={current().method === "confirm"}>
                <span class="flex-1" />
                <Button variant="neutral" onClick={() => answerExtensionUi({ id: current().id, confirmed: false })}>
                  No
                </Button>
                <Button variant="contrast" onClick={() => answerExtensionUi({ id: current().id, confirmed: true })}>
                  Yes
                </Button>
              </Match>
              <Match when={current().method === "select"}>
                <span class="flex-1" />
                <Button variant="ghost" onClick={cancel}>
                  Cancel
                </Button>
              </Match>
              <Match when={current().method === "input" || current().method === "editor"}>
                <span class="flex-1" />
                <Button variant="ghost" onClick={cancel}>
                  Cancel
                </Button>
                <Button variant="contrast" onClick={() => answerExtensionUi({ id: current().id, value: text() })}>
                  Submit
                </Button>
              </Match>
            </Switch>
          }
        >
          <Switch>
            <Match when={current().method === "confirm" ? current() : null}>
              {(confirmPrompt) => <p data-slot="ext-message">{(confirmPrompt() as { message: string }).message}</p>}
            </Match>

            <Match when={current().method === "select" ? current() : null}>
              {(selectPrompt) => (
                <div data-slot="ext-options" role="listbox">
                  <For each={(selectPrompt() as { options: string[] }).options}>
                    {(option, index) => (
                      <button
                        type="button"
                        role="option"
                        data-slot="ext-option"
                        data-active={choice() === index() ? "" : undefined}
                        aria-selected={choice() === index()}
                        onMouseEnter={() => setChoice(index())}
                        onClick={() => answerExtensionUi({ id: current().id, value: option })}
                      >
                        {option}
                      </button>
                    )}
                  </For>
                </div>
              )}
            </Match>

            <Match when={current().method === "input" ? current() : null}>
              {(inputPrompt) => (
                <input
                  data-slot="ext-input"
                  autofocus
                  value={text()}
                  placeholder={(inputPrompt() as { placeholder?: string }).placeholder ?? ""}
                  onInput={(event) => setText(event.currentTarget.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") answerExtensionUi({ id: current().id, value: text() });
                    if (event.key === "Escape") cancel();
                  }}
                />
              )}
            </Match>

            <Match when={current().method === "editor"}>
              <textarea
                data-slot="ext-editor"
                autofocus
                rows={14}
                value={text()}
                onInput={(event) => setText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    answerExtensionUi({ id: current().id, value: text() });
                  }
                  if (event.key === "Escape") cancel();
                }}
              />
            </Match>
          </Switch>

          <Show when={state.extensionPrompts.length > 1}>
            <div data-slot="ext-queue">{state.extensionPrompts.length - 1} more waiting</div>
          </Show>
        </Dialog>
      )}
    </Show>
  );
}
