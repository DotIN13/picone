import { For, Show, createMemo, createSignal } from "solid-js";
import { Popover } from "@kobalte/core/popover";
import type { ModelOption, ThinkingLevel } from "@picone/protocol";
import { sessionSummary, setSessionModel, state } from "../store.ts";
import { Icon } from "./ui/icon.tsx";
import { Dialog } from "./ui/primitives.tsx";

/** Pi's thinking levels, lowest effort first. */
const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Keep the user's intent when switching to a model that does not offer the
 * current level: take the nearest one it does, rather than silently resetting.
 */
function nearestLevel(wanted: string | undefined, supported: ThinkingLevel[]): ThinkingLevel | undefined {
  if (supported.length === 0) return undefined;
  if (wanted && supported.includes(wanted as ThinkingLevel)) return wanted as ThinkingLevel;

  const target = THINKING_LEVELS.indexOf((wanted as ThinkingLevel) ?? "medium");
  const from = target === -1 ? THINKING_LEVELS.indexOf("medium") : target;
  return supported.reduce((best, level) =>
    Math.abs(THINKING_LEVELS.indexOf(level) - from) < Math.abs(THINKING_LEVELS.indexOf(best) - from) ? level : best,
  );
}

/**
 * Model and thinking level for the active session, under the composer.
 * Changing it takes effect on the next turn and becomes the workspace default.
 */
export function ModelPicker() {
  const [open, setOpen] = createSignal(false);
  const [filter, setFilter] = createSignal("");

  const current = createMemo(() => (state.activeSessionId ? sessionSummary(state.activeSessionId)?.model : undefined));

  /** Capabilities for whatever the session is running right now. */
  const currentOption = createMemo<ModelOption | undefined>(() => {
    const model = current();
    if (!model) return undefined;
    return state.models.find((m) => m.provider === model.provider && m.id === model.model);
  });

  const levels = createMemo<ThinkingLevel[]>(() => currentOption()?.thinkingLevels ?? []);

  const label = createMemo(() => current()?.model ?? "default model");

  const filtered = createMemo(() => {
    const needle = filter().toLowerCase().trim();
    if (!needle) return state.models;
    return state.models.filter((m) => `${m.provider}/${m.id}`.toLowerCase().includes(needle));
  });

  const pick = (option: ModelOption) => {
    // Carry the thinking level across only as far as the new model allows.
    const level = nearestLevel(current()?.thinking, option.thinkingLevels);
    void setSessionModel(option.provider, option.id, level);
    setOpen(false);
    setFilter("");
  };

  /*
   * One body, two containers. On a phone an anchored popover is squeezed
   * between the keyboard and the safe area with a search field in it, so the
   * same content becomes the bottom sheet the Dialog primitive already knows
   * how to be (§47). The desktop keeps the popover, which belongs beside the
   * control it came from.
   */
  const body = () => (
    <>
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
                onClick={() => pick(model)}
              >
                <span data-slot="model-item-provider">{model.provider}</span>
                <span class="truncate">{model.id}</span>
                <Show when={current()?.provider === model.provider && current()?.model === model.id}>
                  <Icon name="check" size={13} class="ml-auto shrink-0 text-v2-icon-icon-accent" />
                </Show>
              </button>
            )}
          </For>
        </Show>
      </div>

      {/* Only the levels this model accepts, and nothing at all when it has
          none — an empty row explaining its own absence is just noise. */}
      <Show when={levels().length > 0}>
        <div data-slot="model-thinking-row">
          <span class="text-v2-text-text-faint">Thinking</span>
          <div data-slot="model-thinking-options">
            <For each={levels()}>
              {(level) => (
                <button
                  type="button"
                  data-slot="model-thinking-option"
                  data-selected={current()?.thinking === level ? "" : undefined}
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
      </Show>
    </>
  );

  const trigger = (
    <>
      <Icon name="sparkle" size={12} />
      {/*
        The name and the badge are wrapped, because the two alignments here are
        different jobs. Within the pair it is a baseline: they are 12px and 10px
        and their letters have to sit on one line. Between the pair and the
        button it is centring — a button with a min-height taller than its text
        has slack, and baseline alignment would drop all of it below the words.
      */}
      <span data-slot="model-label">
        <span class="truncate">{label()}</span>
        <Show when={current()?.thinking && current()!.thinking !== "off" && levels().length > 0}>
          <span data-slot="model-thinking">{current()!.thinking}</span>
        </Show>
      </span>
      <Icon name="chevron-down" size={11} class="opacity-60" />
    </>
  );

  return (
    <Show
      when={state.compact}
      fallback={
        <Popover open={open()} onOpenChange={setOpen} placement="top-start" gutter={6}>
          <Popover.Trigger data-slot="model-trigger" title={label()} disabled={!state.activeSessionId}>
            {trigger}
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content data-component="model-popover">{body()}</Popover.Content>
          </Popover.Portal>
        </Popover>
      }
    >
      <button
        type="button"
        data-slot="model-trigger"
        // Narrow rows truncate the name, so the whole of it stays reachable.
        title={label()}
        disabled={!state.activeSessionId}
        onClick={() => setOpen(true)}
      >
        {trigger}
      </button>
      <Dialog open={open()} onOpenChange={setOpen} title="Model" fill>
        <div data-component="model-popover" data-sheet="">
          {body()}
        </div>
      </Dialog>
    </Show>
  );
}
