import { For, Show, createSignal, type JSX } from "solid-js";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import type { AgentKind } from "@picone/protocol";
import { newSession, state } from "../store.ts";
import { Icon, type IconName } from "./ui/icon.tsx";
import { Dialog } from "./ui/primitives.tsx";
import type { AgentAvailability } from "../lib/api.ts";

/** The mark for each agent (§58), decided in one place. */
export function agentIcon(agent: AgentKind | undefined): IconName {
  return agent === "claude" ? "agent-claude" : "agent-pi";
}

export function agentLabel(agent: AgentKind | undefined): string {
  return agent === "claude" ? "Claude" : "Pi";
}

/**
 * Start a session, with a choice of agent (§58).
 *
 * The `+` opens the choice rather than hiding it behind a second control. It
 * was a split button — click to start, caret to choose — which put the more
 * interesting half in a 14px target nobody would find, and left the two `+`
 * buttons in the app behaving differently from each other. One extra click is
 * a fair price for the choice being visible from both.
 *
 * With one agent installed there is nothing to choose, so the `+` goes back to
 * starting a session outright.
 */
export function NewSessionButton(props: { variant?: "sidebar" | "tab" }) {
  const [open, setOpen] = createSignal(false);
  const choices = () => state.agents;
  const preferred = (): AgentKind => state.workspace?.file.agent ?? "pi";

  /** What that agent would run, from what the workspace remembers (§58). */
  const model = (agent: AgentKind): string | undefined => {
    const file = state.workspace?.file;
    const remembered = file?.models?.[agent] ?? (agent === "pi" ? file?.model : undefined);
    return remembered?.model || undefined;
  };

  const start = async (agent?: AgentKind) => {
    setOpen(false);
    await newSession(agent);
  };

  const slot = () => (props.variant === "tab" ? "tab-new" : "sidebar-new");
  const size = () => (props.variant === "tab" ? 14 : 13);

  /** One row's contents, the same in a menu and in a sheet. */
  const row = (agent: AgentAvailability): JSX.Element => (
    <>
      <Icon name={agentIcon(agent.kind)} size={15} />
      <span data-slot="agent-name">{agent.name}</span>
      <Show when={agent.kind === preferred()}>
        <Icon name="check" size={12} />
      </Show>
      {/* What you would get: the model this agent was last given, or the
          reason it cannot be given one. */}
      <Show when={agent.available} fallback={<span data-slot="agent-note">{agent.reason}</span>}>
        <Show when={model(agent.kind)}>{(name) => <span data-slot="agent-note">{name()}</span>}</Show>
      </Show>
    </>
  );

  const trigger = (onClick?: () => void) => (
    <button type="button" data-slot={slot()} aria-label="New session" title="New session" onClick={onClick}>
      <Icon name="plus" size={size()} />
    </button>
  );

  return (
    <Show when={choices().length > 1} fallback={trigger(() => void start())}>
      {/*
        One list, two containers (§47). On a phone an anchored menu opens
        against the edge of a 380px sidebar with nothing to anchor to and the
        keyboard about to arrive, so the same rows become the bottom sheet the
        Dialog primitive already knows how to be. The desktop keeps the menu,
        which belongs beside the button it came from — and gets roving focus,
        typeahead and Escape from Kobalte for free.
      */}
      <Show
        when={state.compact}
        fallback={
          <DropdownMenu open={open()} onOpenChange={setOpen} placement="bottom-start" gutter={6}>
            <DropdownMenu.Trigger data-slot={slot()} aria-label="New session" title="New session">
              <Icon name="plus" size={size()} />
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content data-component="agent-menu">
                <div data-slot="agent-heading">New session with</div>
                <For each={choices()}>
                  {(agent) => (
                    <DropdownMenu.Item
                      data-slot="agent-option"
                      data-current={agent.kind === preferred() ? "" : undefined}
                      disabled={!agent.available}
                      onSelect={() => void start(agent.kind)}
                    >
                      {row(agent)}
                    </DropdownMenu.Item>
                  )}
                </For>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu>
        }
      >
        {trigger(() => setOpen(true))}
        <Dialog open={open()} onOpenChange={setOpen} title="New session with" fill>
          <div data-component="agent-menu" data-sheet="">
            <For each={choices()}>
              {(agent) => (
                <button
                  type="button"
                  data-slot="agent-option"
                  data-current={agent.kind === preferred() ? "" : undefined}
                  disabled={!agent.available}
                  onClick={() => void start(agent.kind)}
                >
                  {row(agent)}
                </button>
              )}
            </For>
          </div>
        </Dialog>
      </Show>
    </Show>
  );
}
