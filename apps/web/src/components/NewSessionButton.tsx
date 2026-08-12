import { For, Show, createSignal } from "solid-js";
import { Popover } from "@kobalte/core/popover";
import type { AgentKind } from "@picone/protocol";
import { newSession, state } from "../store.ts";
import { Icon } from "./ui/icon.tsx";
import { IconButton } from "./ui/button.tsx";

/**
 * Start a session, with a choice of agent (§57).
 *
 * The click is the common case and stays one click: it starts a session with
 * whatever the workspace last used. The caret beside it is for the other case,
 * and choosing there also sets the workspace's default — the same bargain the
 * model picker makes, so the choice is made once rather than every time.
 *
 * An agent that cannot run is listed with its reason rather than hidden. "No
 * Claude executable found" is a thing to go and fix; a missing menu entry is a
 * thing to wonder about.
 */
export function NewSessionButton(props: { size?: "small" | "normal" }) {
  const [open, setOpen] = createSignal(false);

  const preferred = (): AgentKind => state.workspace?.file.agent ?? "pi";
  /** Only worth a caret when there is more than one thing behind it. */
  const choices = () => state.agents;

  const start = async (agent?: AgentKind) => {
    setOpen(false);
    await newSession(agent);
  };

  return (
    <div data-component="new-session">
      <IconButton
        icon="plus"
        label="New session"
        size={props.size ?? "normal"}
        onClick={() => void start()}
      />
      <Show when={choices().length > 1}>
        <Popover open={open()} onOpenChange={setOpen} placement="bottom-end" gutter={6}>
          <Popover.Trigger data-slot="new-session-more" title="New session with…" aria-label="Choose an agent">
            <Icon name="chevron-down" size={10} />
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content data-component="agent-popover">
              <div data-slot="agent-heading">New session with</div>
              <For each={choices()}>
                {(agent) => (
                  <button
                    type="button"
                    data-slot="agent-option"
                    data-current={agent.kind === preferred() ? "" : undefined}
                    disabled={!agent.available}
                    title={agent.reason}
                    onClick={() => void start(agent.kind)}
                  >
                    <span data-slot="agent-name">{agent.name}</span>
                    <Show when={agent.kind === preferred()}>
                      <Icon name="check" size={11} />
                    </Show>
                    <Show when={!agent.available}>
                      <span data-slot="agent-reason">{agent.reason}</span>
                    </Show>
                  </button>
                )}
              </For>
            </Popover.Content>
          </Popover.Portal>
        </Popover>
      </Show>
    </div>
  );
}

/**
 * Which agent a session belongs to, at a glance.
 *
 * A glyph rather than a word: a session row already carries a title, an
 * excerpt and a time, and the agent is the least of those until it is the one
 * you are looking for. Nothing is drawn for the workspace's usual agent —
 * marking every row would be marking nothing.
 */
export function AgentMark(props: { agent?: AgentKind; class?: string }) {
  const shown = () => props.agent && props.agent !== (state.workspace?.file.agent ?? "pi");
  return (
    <Show when={shown()}>
      <span data-slot="agent-mark" class={props.class} title={props.agent === "claude" ? "Claude" : "Pi"}>
        {props.agent === "claude" ? "C" : "π"}
      </span>
    </Show>
  );
}
