import { For, Show } from "solid-js";
import {
  activeSessionState,
  setSettingsOpen,
  setWorkspacePickerOpen,
  state,
  surfaceOf,
  toggleColorScheme,
  toggleSidebar,
} from "../store.ts";
import { IconButton } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Tooltip } from "./ui/primitives.tsx";

/**
 * One pill for the whole of "what is going on", connection included — a green
 * dot in the corner was a second status display in a language of its own.
 *
 * Thinking, writing and running a tool are all the agent being busy, and the
 * transcript already says which; they collapse to *working*. Waiting for a
 * permission does not: the agent has stopped and it is now the human's move,
 * which is the one state worth interrupting for.
 */
type Status = "offline" | "idle" | "working" | "waiting_permission";

const LABEL: Record<Status, string> = {
  offline: "Offline",
  idle: "Idle",
  working: "Working",
  waiting_permission: "Waiting for you",
};

export function TitleBar() {
  const connectedMcp = () => state.mcp.filter((m) => m.status === "connected").length;

  const status = (): Status => {
    // Disconnected outranks everything: whatever the session was doing, what is
    // on screen is a snapshot from before the socket dropped.
    if (!state.connected) return "offline";
    const agent = activeSessionState();
    if (agent === "idle" || agent === "waiting_permission") return agent;
    return "working";
  };

  /**
   * Offline is worth showing with no workspace open; the rest is not.
   *
   * None of it is worth the room on a phone, where the bar is a few hundred
   * pixels already truncating the workspace name. What the pill reports is
   * legible elsewhere: the composer shows the agent working, a permission
   * request is a card in the transcript, and a dropped socket announces itself
   * the moment you try to send anything.
   */
  const showStatus = () =>
    !state.compact && (!state.connected || Boolean(state.workspace && state.activeSessionId));

  return (
    <header data-slot="titlebar">
      <div class="flex min-w-0 items-center gap-1.5">
        {/* Compact puts this control in the tab bar, next to what it reveals. */}
        <Show when={state.workspace && !state.compact}>
          <IconButton
            icon="panel"
            label={state.sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}
            variant="ghost-muted"
            onClick={toggleSidebar}
          />
        </Show>

        <button type="button" data-slot="titlebar-workspace" onClick={() => setWorkspacePickerOpen(true)}>
          <span data-slot="titlebar-mark">
            <Icon name="sparkle" size={13} />
          </span>
          <span class="truncate">{state.workspace ? state.workspace.file.name : "No workspace"}</span>
          <Icon name="chevron-down" size={12} class="opacity-60" />
        </button>

        <Show when={showStatus()}>
          <Tooltip
            label={
              status() === "offline"
                ? "Cannot reach the agent server — retrying"
                : `The active session is ${LABEL[status()].toLowerCase()}`
            }
          >
            <span data-slot="titlebar-state" data-state={status()}>{LABEL[status()]}</span>
          </Tooltip>
        </Show>
      </div>

      <div class="flex items-center gap-1.5">
        {/* Extension `setStatus` entries live here, the way the TUI footer
            shows them — the active session's, since they belong to one. */}
        <For each={Object.entries(surfaceOf().status)}>
          {([key, text]) => (
            <Tooltip label={`Set by an extension (${key})`}>
              <span data-slot="titlebar-ext-status">{text}</span>
            </Tooltip>
          )}
        </For>

        <Show when={connectedMcp() > 0}>
          <Tooltip label={`${connectedMcp()} MCP server${connectedMcp() === 1 ? "" : "s"} connected`}>
            <span data-slot="titlebar-meta">
              <Icon name="plug" size={13} />
              {connectedMcp()}
            </span>
          </Tooltip>
        </Show>

        <IconButton
          icon={state.colorScheme === "dark" ? "sun" : "moon"}
          label={state.colorScheme === "dark" ? "Light theme" : "Dark theme"}
          variant="ghost-muted"
          onClick={toggleColorScheme}
        />

        <Show when={state.workspace}>
          <IconButton icon="settings" label="Workspace settings" variant="ghost-muted" onClick={() => setSettingsOpen(true)} />
        </Show>
      </div>
    </header>
  );
}
