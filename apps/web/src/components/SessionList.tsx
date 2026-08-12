import { For, Show, createMemo, createSignal } from "solid-js";
import type { SessionSummary } from "@picone/protocol";
import { deleteSession, newSession, openSession, renameSession, state } from "../store.ts";
import { IconButton } from "./ui/button.tsx";
import { Icon } from "./ui/icon.tsx";
import { AgentMark, NewSessionButton } from "./NewSessionButton.tsx";
import { Spinner } from "./ui/primitives.tsx";

/**
 * Sessions in this workspace (DESIGN §27).
 *
 * A row answers "which conversation was this?" — the name, a line of the most
 * recent message, and when it last moved. The model is deliberately not here:
 * it is the same for nearly every session, it changes under you, and it is
 * already on the composer where it can be changed.
 */
export function SessionList() {
  const [editing, setEditing] = createSignal<string | null>(null);
  const [draft, setDraft] = createSignal("");
  const [filter, setFilter] = createSignal("");

  const isOpen = (id: string) => state.tabs.some((tab) => tab.id === id);
  const busy = (id: string) => {
    const agentState = state.agentStates[id];
    return agentState !== undefined && agentState !== "idle";
  };

  /** Title first, then what was said — a search that only matched titles would
      miss the session you remember by its contents. */
  const shown = createMemo(() => {
    const needle = filter().trim().toLowerCase();
    if (!needle) return state.sessions;
    return state.sessions.filter(
      (session) =>
        session.title.toLowerCase().includes(needle) || (session.excerpt ?? "").toLowerCase().includes(needle),
    );
  });

  return (
    <div class="flex min-h-0 flex-1 flex-col">
      <div class="flex items-center gap-1 px-2 pb-2">
        <div data-slot="sidebar-search">
          <Icon name="search" size={13} />
          <input
            type="search"
            placeholder="Filter sessions…"
            value={filter()}
            onInput={(event) => setFilter(event.currentTarget.value)}
          />
        </div>
        <NewSessionButton />
      </div>

      <ul class="min-h-0 flex-1 overflow-auto px-2 pb-2">
        <Show when={shown().length === 0}>
          <li data-slot="sidebar-empty">{filter().trim() ? "No matches" : "No sessions yet"}</li>
        </Show>

        <For each={shown()}>
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
                  <span data-slot="session-head">
                    <Show when={busy(session.id)}>
                      <Spinner size={8} />
                    </Show>
                    <span data-slot="session-title">{session.title}</span>
                    <AgentMark agent={session.agent} />
                    <Show when={session.forkedFrom}>
                      <span data-slot="session-fork" title="Forked from another session">
                        <Icon name="git-branch" size={9} />
                        fork
                      </span>
                    </Show>
                  </span>

                  <Show when={session.excerpt}>
                    {(excerpt) => <span data-slot="session-excerpt">{excerpt()}</span>}
                  </Show>

                  <span data-slot="session-time">{when(session)}</span>
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

/**
 * How long ago, in the shortest form that is still true. A full timestamp on
 * every row is a column of near-identical text; what a reader wants from a
 * list is which one is recent.
 */
function when(session: SessionSummary): string {
  const then = new Date(session.updatedAt);
  const minutes = Math.floor((Date.now() - then.getTime()) / 60_000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h ago`;
  if (minutes < 7 * 24 * 60) return `${Math.floor(minutes / (24 * 60))}d ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
