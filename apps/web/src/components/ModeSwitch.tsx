import { For, Show, createSignal } from "solid-js";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import type { AgentMode } from "@picone/protocol";
import { activeCapabilities, activeMode, setMode, state } from "../store.ts";
import { Icon, type IconName } from "./ui/icon.tsx";

/**
 * How the agent is allowed to act, for the rest of the session (§58).
 *
 * Claude Code's four modes, and they are not a message passed through: Picone
 * is the permission surface, so each one is a lens over the workspace's
 * permissions that our own gate applies. What the menu describes is therefore
 * what will actually happen, not what the agent has been asked to intend.
 *
 * Left of the model picker, being the larger of the two decisions — what the
 * agent may do at all, rather than which one is doing it. Drawn only where the
 * agent has more than one mode, which today means Claude; Pi has one way of
 * working and an empty `capabilities.modes` says so.
 */
const MODES: Array<{ mode: AgentMode; label: string; icon: IconName; note: string }> = [
  {
    mode: "manual",
    label: "manual",
    icon: "shield",
    note: "Ask about whatever the workspace settings say to ask about.",
  },
  {
    mode: "edit",
    label: "edit",
    icon: "rename",
    note: "Stop asking about file changes inside the workspace. Shell and git still ask.",
  },
  {
    mode: "plan",
    label: "plan",
    icon: "plan",
    note: "Change nothing at all: read, think, and propose a plan to approve.",
  },
  {
    mode: "auto",
    label: "auto",
    icon: "sparkle",
    note: "Stop asking altogether. Anything the settings would ask about, it does.",
  },
];

export function ModeSwitch() {
  const [open, setOpen] = createSignal(false);
  const available = () => MODES.filter((entry) => (activeCapabilities()?.modes ?? []).includes(entry.mode));
  const current = () => MODES.find((entry) => entry.mode === activeMode()) ?? MODES[0]!;

  return (
    <Show when={state.activeSessionId && available().length > 1}>
      <DropdownMenu open={open()} onOpenChange={setOpen} placement="top-start" gutter={6}>
        <DropdownMenu.Trigger
          data-slot="mode-switch"
          /* Anything but the ordinary mode is a standing change to how this
             session behaves, so it is filled rather than merely labelled. */
          data-on={activeMode() !== "manual" ? "" : undefined}
          title={current().note}
        >
          <Icon name={current().icon} size={13} />
          <span>{current().label}</span>
          <Icon name="chevron-down" size={10} class="opacity-60" />
        </DropdownMenu.Trigger>
        <DropdownMenu.Portal>
          <DropdownMenu.Content data-component="mode-menu">
            <div data-slot="mode-heading">How it may act</div>
            <For each={available()}>
              {(entry) => (
                <DropdownMenu.Item
                  data-slot="mode-option"
                  data-current={entry.mode === activeMode() ? "" : undefined}
                  onSelect={() => setMode(entry.mode)}
                >
                  <Icon name={entry.icon} size={14} />
                  <span data-slot="mode-option-label">
                    {entry.label}
                    <Show when={entry.mode === activeMode()}>
                      <Icon name="check" size={11} />
                    </Show>
                  </span>
                  <span data-slot="mode-option-note">{entry.note}</span>
                </DropdownMenu.Item>
              )}
            </For>
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu>
    </Show>
  );
}
