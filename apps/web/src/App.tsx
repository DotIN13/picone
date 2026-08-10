import { For, Show, createEffect, onMount } from "solid-js";
import {
  closeSidebarOverlay,
  dismissToast,
  init,
  newSession,
  setLayout,
  setWorkspacePickerOpen,
  state,
  updateAppSettings,
} from "./store.ts";
import { SIDEBAR_WIDTH } from "./lib/app-settings.ts";
import { COARSE_QUERY, COMPACT_QUERY, mediaQuery, trackVisualViewport } from "./lib/media.ts";
import { TitleBar } from "./components/TitleBar.tsx";
import { Resizer } from "./components/Resizer.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { TabBar } from "./components/TabBar.tsx";
import { ChatTab } from "./components/ChatTab.tsx";
import { FileTab } from "./components/FileTab.tsx";
import { Composer } from "./components/Composer.tsx";
import { WorkspacePicker } from "./components/WorkspacePicker.tsx";
import { SettingsDrawer } from "./components/SettingsDrawer.tsx";
import { ExtensionDialog } from "./components/ExtensionDialog.tsx";
import { Button, IconButton } from "./components/ui/button.tsx";
import { Icon } from "./components/ui/icon.tsx";
import { Spinner } from "./components/ui/primitives.tsx";

export function App() {
  const compact = mediaQuery(COMPACT_QUERY);
  const coarse = mediaQuery(COARSE_QUERY);

  onMount(() => {
    void init();
    trackVisualViewport();
  });

  createEffect(() => setLayout({ compact: compact(), coarse: coarse() }));

  const sidebarVisible = () => (state.compact ? state.sidebarOverlayOpen : !state.sidebarCollapsed);

  return (
    <div data-slot="app" data-compact={state.compact ? "" : undefined}>
      <TitleBar />

      <Show
        when={state.workspace}
        fallback={
          <div data-slot="splash">
            <div data-slot="splash-mark">
              <Icon name="sparkle" size={22} />
            </div>
            {/* Reopening a workspace builds a Pi session, which takes a moment.
                Say so instead of showing the picker over it. */}
            <Show
              when={state.restoring}
              fallback={
                <>
                  <div class="flex flex-col items-center gap-1">
                    <h1 class="text-[calc(18px*var(--font-scale))] font-[530] tracking-[-0.2px]">Picone</h1>
                    <p class="text-[calc(13px*var(--font-scale))] text-v2-text-text-muted">Open a workspace to begin.</p>
                  </div>
                  <Button variant="contrast" size="large" onClick={() => setWorkspacePickerOpen(true)}>
                    Open workspace
                  </Button>
                </>
              }
            >
              {(path) => (
                <div class="flex flex-col items-center gap-2">
                  <div class="flex items-center gap-2 text-[calc(14px*var(--font-scale))] font-[530]">
                    <Spinner size={11} />
                    Reopening workspace…
                  </div>
                  <code data-slot="settings-path" class="max-w-[420px]">
                    {path()}
                  </code>
                  <Button variant="ghost" onClick={() => setWorkspacePickerOpen(true)}>
                    Open a different one
                  </Button>
                </div>
              )}
            </Show>
          </div>
        }
      >
        <div data-slot="body">
          {/* On phones the sidebar is an overlay drawer over the content; on
              desktop it is a column beside it. Same component either way. */}
          <Show when={state.compact && state.sidebarOverlayOpen}>
            <div data-slot="sidebar-scrim" onClick={closeSidebarOverlay} />
          </Show>

          <Show when={sidebarVisible()}>
            <Sidebar />
          </Show>

          {/* Only beside a real column. As an overlay the sidebar floats over
              the work and there is no boundary to move. */}
          <Show when={sidebarVisible() && !state.compact}>
            <Resizer
              label="Resize sidebar"
              value={state.app.appearance.sidebarWidth}
              onChange={(sidebarWidth) => updateAppSettings({ appearance: { sidebarWidth } })}
              min={SIDEBAR_WIDTH.min}
              max={SIDEBAR_WIDTH.max}
              reset={SIDEBAR_WIDTH.default}
            />
          </Show>

          <main data-slot="main">
            <TabBar />

            <div data-slot="tab-content">
              {/* Every open tab stays mounted, so a background session keeps
                  streaming while the user reads something else (DESIGN §20). */}
              <For each={state.tabs}>
                {(tab) => (
                  <div data-slot="pane" classList={{ hidden: state.activeTabId !== tab.id }}>
                    <Show when={tab.kind === "session"} fallback={<FileTab path={tab.id} />}>
                      <ChatTab sessionId={tab.id} />
                    </Show>
                  </div>
                )}
              </For>

              <Show when={state.tabs.length === 0}>
                <div data-slot="pane" class="items-center justify-center gap-4">
                  <div data-slot="chat-empty-mark">
                    <Icon name="comment" size={18} />
                  </div>
                  <p class="text-v2-text-text-muted">No tabs open.</p>
                  <Button variant="contrast" icon="plus" onClick={() => void newSession()}>
                    New session
                  </Button>
                </div>
              </Show>
            </div>

            <Composer />
          </main>
        </div>
      </Show>

      <WorkspacePicker />
      <SettingsDrawer />
      <ExtensionDialog />

      <Show when={state.toast}>
        {(toast) => (
          <div data-component="toast" data-level={toast().level} role="status">
            <Icon name={toast().level === "error" ? "alert" : "sparkle"} />
            <span class="flex-1">{toast().text}</span>
            <IconButton icon="close" label="Dismiss" size="small" variant="ghost-muted" onClick={dismissToast} />
          </div>
        )}
      </Show>
    </div>
  );
}
