import { For, Show, createSignal } from "solid-js";
import { deleteSession, newSession, openSession, renameSession, state } from "../store.ts";
import { Button, IconButton } from "./ui/button.tsx";
import { Spinner } from "./ui/primitives.tsx";

export function SessionList() {
  const [editing, setEditing] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");

  const isOpen = (id: string) => state.tabs.some((tab) => tab.id === id);
  const busy = (id: string) => {
    const agentState = state.agentStates[id];
    return agentState !== undefined && agentState !== "idle";
  };

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-center justify-between px-3 pb-2">
        <span data-slot="section-title">Sessions</span>
        <Button size="small" variant="ghost" icon="plus" onClick={() => void newSession()}>
          New
        </Button>
      </div>

      <ul class="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <For each={state.sessions}>
          {(session) => (
            <li
              data-slot="session-row"
              data-active={session.id === state.activeSessionId ? "" : undefined}
              data-open={isOpen(session.id) ? "" : undefined}
            >
              <Show
                when={editing() !== session.id}
                fallback={
                  <input
                    data-slot="session-rename"
                    autofocus
                    value={draft()}
                    onInput={(event) => setDraft(event.currentTarget.value)}
                    onBlur={() => {
                      void renameSession(session.id, draft().trim() || session.title);
                      setEditing(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") event.currentTarget.blur();
                      if (event.key === "Escape") setEditing(null);
                    }}
                  />
                }
              >
                <button type="button" data-slot="session-open" onClick={() => void openSession(session.id)}>
                  <span class="flex w-full items-center gap-1.5">
                    <Show when={busy(session.id)}>
                      <Spinner size={8} />
                    </Show>
                    <span class="truncate">{session.title}</span>
                  </span>
                  <span data-slot="session-time">
                    {new Date(session.updatedAt).toLocaleString()}
                    <Show when={session.model}> · {session.model!.model}</Show>
                  </span>
                </button>
                <div data-slot="session-actions">
                  <IconButton
                    icon="rename"
                    label="Rename session"
                    size="small"
                    variant="ghost-muted"
                    onClick={() => {
                      setEditing(session.id);
                      setDraft(session.title);
                    }}
                  />
                  <IconButton
                    icon="close"
                    label="Delete session"
                    size="small"
                    variant="ghost-muted"
                    onClick={() => void deleteSession(session.id)}
                  />
                </div>
              </Show>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}
