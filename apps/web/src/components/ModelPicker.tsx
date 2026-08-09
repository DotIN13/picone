import { For, Show, createMemo, createSignal } from "solid-js";
import { Popover } from "@kobalte/core/popover";
import { sessionSummary, setSessionModel, state } from "../store.ts";
import { Icon } from "./ui/icon.tsx";

const THINKING = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Model and thinking level for the active session, under the composer.
 * Changing it takes effect on the next turn and becomes the workspace default.
 */
export function ModelPicker() {
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");

  const current = createMemo(() => (state.activeSessionId ? sessionSummary(state.activeSessionId)?.model : undefined));

  const label = createMemo(() => {
    const model = current();
    if (!model) return "default model";
    return model.model;
  });

  const filtered = createMemo(() => {
    const needle = filter().toLowerCase().trim();
    if (!needle) return state.models;
    return state.models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(needle));
  });

  const pick = (provider: string, model: string) => {
    void setSessionModel(provider, model, current()?.thinking);
    setOpen(false);
    setFilter("");
  };

  return (
    <Popover open={open()} onOpenChange={setOpen} placement="top-start" gutter={6}>
      <Popover.Trigger data-slot="model-trigger" disabled={!state.activeSessionId}>
        <Icon name="sparkle" size={12} />
        <span class="truncate">{label()}</span>
        <Show when={current()?.thinking && current()!.thinking !== "off"}>
          <span data-slot="model-thinking">{current()!.thinking}</span>
        </Show>
        <Icon name="chevron-down" size={11} class="opacity-60" />
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content data-component="model-popover">
          <div data-slot="model-search">
            <Icon name="search" size={13} />
            <input
              autofocus
              placeholder="Search models…"
              value={filter()}
              onInput={(event) => setFilter(event.currentTarget.value)}
            />
          </div>

          <div data-slot="model-list">
            <Show when={filtered().length > 0} fallback={<div data-slot="model-empty">No matching models</div>}>
              <For each={filtered()}>
                {(model) => (
                  <button
                    type="button"
                    data-slot="model-item"
                    data-selected={
                      current()?.provider === model.provider && current()?.model === model.id ? "" : undefined
                    }
                    onClick={() => pick(model.provider, model.id)}
                  >
                    <span data-slot="model-item-provider">{model.provider}</span>
                    <span class="truncate">{model.id}</span>
                    <Show when={current()?.provider === model.provider && current()?.model === model.id}>
                      <Icon name="check" size={13} class="ml-auto text-v2-icon-icon-accent" />
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </div>

          <div data-slot="model-thinking-row">
            <span class="text-v2-text-text-faint">Thinking</span>
            <div data-slot="model-thinking-options">
              <For each={THINKING}>
                {(level) => (
                  <button
                    type="button"
                    data-slot="model-thinking-option"
                    data-selected={(current()?.thinking ?? "off") === level ? "" : undefined}
                    disabled={!current()}
                    onClick={() => {
                      const model = current();
                      if (model) void setSessionModel(model.provider, model.model, level);
                    }}
                  >
                    {level}
                  </button>
                )}
              </For>
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover>
  );
}
