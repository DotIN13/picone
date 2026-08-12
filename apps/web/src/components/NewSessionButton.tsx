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
 * The `+` opens the choice rather than hiding it behind a second control — it
 * was a split button, which put the more interesting half in a 14px target
 * nobody would find and made the sidebar's `+` and the tab bar's `+` behave
 * differently from each other.
 *
 * Two shapes for one list. A pointer gets a menu under the button it came
 * from, which is what a small choice looks like on a desktop and costs nothing
 * to dismiss. A finger gets a dialog with a box per agent: a menu item sized
 * for a cursor is a poor target, and an anchored popover on a phone opens
 * against the edge of the screen with the keyboard about to arrive. Both are
 * the same rows with the same words.
 *
 * With one agent installed there is nothing to choose, so the `+` starts a
 * session outright.
 */
export function NewSessionButton(props: { variant?: "sidebar" | "tab" }) {
  const [open, setOpen] = createSignal(false);
  const choices = () => state.agents;
  const preferred = (): AgentKind => state.workspace?.file.agent ?? "pi";
  /** Touch devices — phones and tablets alike — get the dialog. */
  const touch = () => state.coarse || state.compact;

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
  const many = () => choices().length > 1;

  /**
   * One agent on one line, said the same way in both shapes: the mark, the
   * name, and — pushed to the end — what it would run. Stacking the model
   * under the name gave every row two lines and made a choice between two
   * things look like a settings page.
   */
  const row = (agent: AgentAvailability): JSX.Element => (
    <>
      <Icon name={agentIcon(agent.kind)} size={16} />
      <span data-slot="agent-card-name">
        {agent.name}
        <Show when={agent.kind === preferred()}>
          <span data-slot="agent-default">default</span>
        </Show>
      </span>
      {/* What you would get, or why you cannot have it. */}
      <Show when={agent.available} fallback={<span data-slot="agent-note">unavailable</span>}>
        <span data-slot="agent-note">{model(agent.kind) ?? "default model"}</span>
      </Show>
    </>
  );

  return (
    <Show
      when={many()}
      fallback={
        <button type="button" data-slot={slot()} aria-label="New session" title="New session" onClick={() => void start()}>
          <Icon name="plus" size={size()} />
        </button>
      }
    >
      <Show
        when={touch()}
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
                      disabled={!agent.available}
                      title={agent.reason}
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
        <button
          type="button"
          data-slot={slot()}
          aria-label="New session"
          title="New session"
          aria-haspopup="dialog"
          onClick={() => setOpen(true)}
        >
          <Icon name="plus" size={size()} />
        </button>
        <Dialog
          open={open()}
          onOpenChange={setOpen}
          title="New session"
          description="Choose the agent for this conversation."
          width="min(460px, calc(100 * var(--vw) - 32px))"
          centred
        >
          <div data-component="agent-grid">
            <For each={choices()}>
              {(agent) => (
                <button
                  type="button"
                  data-slot="agent-card"
                  data-current={agent.kind === preferred() ? "" : undefined}
                  disabled={!agent.available}
                  title={agent.reason}
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
