import { For, Show, onCleanup, onMount } from "solid-js";
import { openFile, refreshGitStatus, setFilter, setSidebarMode, state } from "../store.ts";
import { FileTree } from "./FileTree.tsx";
import { SessionList } from "./SessionList.tsx";
import { CommentList } from "./CommentList.tsx";
import { IconButton } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { SegmentedControl, Tooltip } from "./ui/primitives.tsx";

export function Sidebar() {
  onMount(() => {
    const id = window.setInterval(() => void refreshGitStatus(), 15_000);
    onCleanup(() => window.clearInterval(id));
  });

  return (
    <aside data-slot="sidebar">
      <div class="p-2">
        <SegmentedControl
          fullWidth
          value={state.sidebarMode}
          onChange={setSidebarMode}
          options={[
            { value: "files", label: "Files" },
            { value: "sessions", label: "Sessions" },
          ]}
        />
      </div>

      <Show when={state.sidebarMode === "files"} fallback={<SessionList />}>
        <div class="flex items-center gap-1 px-2 pb-2">
          <div data-slot="sidebar-search">
            <Icon name="search" size={13} />
            <input
              type="search"
              placeholder="Filter files…"
              value={state.filter}
              onInput={(event) => setFilter(event.currentTarget.value)}
            />
          </div>
          <IconButton icon="refresh" label="Refresh" size="normal" onClick={() => void refreshGitStatus()} />
        </div>

        <div data-slot="sidebar-scroll" class="min-h-0 flex-1 overflow-auto pb-2">
          <Show when={state.filter.trim().length >= 2} fallback={<FileTree />}>
            <ul>
              <Show when={state.filterResults.length === 0}>
                <li data-slot="sidebar-empty">No matches</li>
              </Show>
              <For each={state.filterResults}>
                {(entry) => (
                  <li>
                    <button type="button" data-slot="search-result" onClick={() => void openFile(entry.path)}>
                      <Icon name="file" size={13} class="shrink-0 text-v2-icon-icon-muted" />
                      <span class="truncate">{entry.name}</span>
                      <span data-slot="search-result-path">{entry.path}</span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
        </div>

        <CommentList />

        <Show when={state.mcp.length > 0}>
          <div data-slot="sidebar-section">
            <div data-slot="section-title">MCP</div>
            <ul class="flex flex-col gap-0.5">
              <For each={state.mcp}>
                {(server) => (
                  <Tooltip label={server.error ?? `${server.toolCount} tools`} placement="right">
                    <li data-slot="mcp-row">
                      <span data-slot="mcp-dot" data-status={server.status} />
                      <span class="truncate">{server.name}</span>
                      <Show when={server.status === "connected"}>
                        <span class="ml-auto text-v2-text-text-faint">{server.toolCount}</span>
                      </Show>
                    </li>
                  </Tooltip>
                )}
              </For>
            </ul>
          </div>
        </Show>
      </Show>
    </aside>
  );
}
