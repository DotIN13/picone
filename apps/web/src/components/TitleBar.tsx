import { For, Show } from "solid-js";
import {
  activeSessionState,
  setSettingsOpen,
  setWorkspacePickerOpen,
  state,
  toggleColorScheme,
  toggleSidebar,
} from "../store.ts";
import { IconButton } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { Tooltip } from "./ui/primitives.tsx";

const STATE_LABEL: Record<string, string> = {
  idle: "Idle",
  thinking: "Thinking",
  streaming: "Writing",
  tool: "Running tools",
  waiting_permission: "Waiting for you",
};

export function TitleBar() {
  const connectedMcp = () => state.mcp.filter((m) => m.status === "connected").length;

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

        <Show when={state.workspace && state.activeSessionId}>
          <span data-slot="titlebar-state" data-state={activeSessionState()}>
            <Show when={activeSessionState() !== "idle"}>
              <span data-slot="titlebar-state-dot" />
            </Show>
            {STATE_LABEL[activeSessionState()] ?? activeSessionState()}
          </span>
        </Show>
      </div>

      <div class="flex items-center gap-1.5">
        {/* Extension `setStatus` entries live here, the way the TUI footer
            shows them. */}
        <For each={Object.entries(state.extensionStatus)}>
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

        <Tooltip label={state.connected ? "Connected to the agent server" : "Disconnected — reconnecting"}>
          <span data-slot="titlebar-conn" data-connected={state.connected ? "" : undefined} />
        </Tooltip>

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
