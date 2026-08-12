import { For, Show, createSignal } from "solid-js";
import type { AgentKind } from "@picone/protocol";
import { newSession, state } from "../store.ts";
import { Icon, type IconName } from "./ui/icon.tsx";
import { Dialog } from "./ui/primitives.tsx";

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
 * A dialog rather than a menu, and a box per agent rather than a row: choosing
 * what will be having the conversation is not the same kind of act as picking
 * an item off a list, and each agent is worth the space to show its mark, what
 * it is called and what it would run. It stays centred on a phone (§47) — the
 * bottom sheet is for something long enough to scroll.
 *
 * With one agent installed there is nothing to choose, so the `+` starts a
 * session outright.
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
  const many = () => choices().length > 1;

  return (
    <>
      <button
        type="button"
        data-slot={slot()}
        aria-label="New session"
        title="New session"
        aria-haspopup={many() ? "dialog" : undefined}
        onClick={() => (many() ? setOpen(true) : void start())}
      >
        <Icon name="plus" size={size()} />
      </button>

      <Dialog
        open={open()}
        onOpenChange={setOpen}
        title="New session"
        description="Which agent should have this conversation?"
        width="min(440px, calc(100 * var(--vw) - 32px))"
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
                onClick={() => void start(agent.kind)}
              >
                <Show when={agent.kind === preferred()}>
                  <span data-slot="agent-card-tick" title="The workspace's usual agent">
                    <Icon name="check" size={11} />
                  </span>
                </Show>
                <span data-slot="agent-card-mark">
                  <Icon name={agentIcon(agent.kind)} size={22} />
                </span>
                <span data-slot="agent-card-name">{agent.name}</span>
                {/* What you would get, or why you cannot have it. */}
                <Show when={agent.available} fallback={<span data-slot="agent-note">{agent.reason}</span>}>
                  <Show when={model(agent.kind)} fallback={<span data-slot="agent-note">default model</span>}>
                    {(name) => <span data-slot="agent-note">{name()}</span>}
                  </Show>
                </Show>
              </button>
            )}
          </For>
        </div>
      </Dialog>
    </>
  );
}
