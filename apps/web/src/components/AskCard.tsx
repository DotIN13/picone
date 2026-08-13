import { For, Show, createSignal } from "solid-js";
import type { AgentAsk } from "@picone/protocol";
import { answerAsk } from "../store.ts";
import { Button } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Tag } from "./ui/primitives.tsx";

/**
 * Something the agent asked, in the transcript (§59).
 *
 * Deliberately the permission card's twin. A permission request is one question
 * with three fixed answers; this is the general case, and the two should look
 * like one mechanism because they are one: the agent needs a decision and the
 * conversation waits. A row rather than a dialog over the top, so it survives a
 * reload and still says afterwards what was decided.
 *
 * Nothing is preselected. An agent's own recommendation is usually its first
 * option, and a card that arrives with that already chosen turns "which of
 * these" into "press the button".
 */
export function AskCard(props: { ask: AgentAsk; answer?: string[] }) {
  /** For a multi-select, what has been ticked so far. */
  const [picked, setPicked] = createSignal<string[]>([]);
  const answered = () => props.answer !== undefined;

  const toggle = (label: string) => {
    setPicked((current) =>
      current.includes(label) ? current.filter((one) => one !== label) : [...current, label],
    );
  };

  return (
    <div data-component="ask" data-kind={props.ask.kind} data-resolved={answered() ? "" : undefined}>
      <div data-slot="ask-head">
        <Icon name={props.ask.kind === "plan" ? "plan" : "comment"} size={14} />
        <span class="font-[530]">{props.ask.question}</span>
        <Show when={props.ask.header}>
          {(header) => <Tag tone={answered() ? "neutral" : "info"}>{header()}</Tag>}
        </Show>
      </div>

      {/* The plan, or whatever else the answer should be given in view of. */}
      <Show when={props.ask.detail}>
        {(detail) => <div data-slot="ask-detail">{detail()}</div>}
      </Show>

      <Show
        when={!answered()}
        fallback={
          <div data-slot="ask-outcome">
            <Icon name={props.answer?.length ? "check" : "minus"} size={13} />
            {props.answer?.length ? props.answer.join(", ") : "Dismissed"}
          </div>
        }
      >
        <Show
          when={props.ask.multiple}
          fallback={
            <div data-slot="ask-options">
              <For each={props.ask.options}>
                {(option, index) => (
                  <button
                    type="button"
                    data-slot="ask-option"
                    onClick={() => answerAsk(props.ask.id, [option.label])}
                  >
                    <span data-slot="ask-option-label">
                      {option.label}
                      {/* Which one the agent put first, said plainly rather
                          than by preselecting it. */}
                      <Show when={index() === 0 && props.ask.options.length > 1}>
                        <span data-slot="ask-suggested">suggested</span>
                      </Show>
                    </span>
                    <Show when={option.description}>
                      {(description) => <span data-slot="ask-option-note">{description()}</span>}
                    </Show>
                    <span data-slot="ask-option-go">
                      <Icon name="chevron-right" size={13} />
                    </span>
                  </button>
                )}
              </For>
            </div>
          }
        >
          <div data-slot="ask-options">
            <For each={props.ask.options}>
              {(option) => (
                <button
                  type="button"
                  data-slot="ask-option"
                  data-picked={picked().includes(option.label) ? "" : undefined}
                  onClick={() => toggle(option.label)}
                >
                  <span data-slot="ask-option-label">
                    <Icon name={picked().includes(option.label) ? "check" : "minus"} size={11} />
                    {option.label}
                  </span>
                  <Show when={option.description}>
                    {(description) => <span data-slot="ask-option-note">{description()}</span>}
                  </Show>
                </button>
              )}
            </For>
          </div>
          <div data-slot="ask-actions">
            <Button
              size="normal"
              variant="contrast"
              disabled={picked().length === 0}
              onClick={() => answerAsk(props.ask.id, picked())}
            >
              Answer
            </Button>
          </div>
        </Show>

        {/* Walking away is an answer the agent has to be told about, so it is a
            button rather than something that only happens by closing a dialog. */}
        <div data-slot="ask-actions">
          <Button size="normal" variant="ghost-muted" onClick={() => answerAsk(props.ask.id, [])}>
            {props.ask.kind === "plan" ? "Not now" : "Skip the question"}
          </Button>
        </div>
      </Show>
    </div>
  );
}
