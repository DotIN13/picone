import { For, Show, createEffect, createSignal, onCleanup } from "solid-js";
import { activeSessionState, closeTab, moveTab, newSession, setActiveTab, state, toggleSidebar } from "../store.ts";
import { Icon } from "./ui/icon.tsx";
import { Spinner } from "./ui/primitives.tsx";

interface DropTarget {
  id: string;
  side: "before" | "after";
}

/** Movement before a press becomes a drag rather than a tap or a scroll. */
const DRAG_THRESHOLD = 8;
/** On touch, a drag has to be deliberate or it fights the scroll gesture. */
/**
 * How long a finger must rest on a tab before it becomes a reorder.
 *
 * 500ms is the platform convention, and the reason to match it is scrolling:
 * once the drag arms, every move is `preventDefault`ed, so a strip that has
 * armed cannot be swiped. At 320ms an ordinary pause before swiping — putting
 * a thumb down and then deciding — reordered the tabs instead of scrolling
 * them.
 */
const LONG_PRESS_MS = 500;

/**
 * Movement that cancels a pending long press.
 *
 * Smaller than the drag threshold, and deliberately below the browser's own
 * touch slop: a finger that has moved at all is scrolling, and waiting for the
 * full threshold leaves a window where the press arms mid-swipe.
 */
const LONG_PRESS_SLOP = 3;

export function TabBar() {
  const [dragging, setDragging] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<DropTarget | null>(null);
  let strip: HTMLDivElement | undefined;

  const commentCount = (path: string) =>
    state.comments.filter((c) => c.path === path && c.status !== "resolved").length;

  const sessionBusy = (id: string) => {
    const agentState = state.agentStates[id];
    return agentState !== undefined && agentState !== "idle";
  };

  // Keep the active tab visible when it changes from elsewhere (sidebar, /new).
  createEffect(() => {
    const id = state.activeTabId;
    if (!id || !strip) return;
    queueMicrotask(() => {
      strip
        ?.querySelector<HTMLElement>(`[data-slot="tab"][data-id="${CSS.escape(id)}"]`)
        ?.scrollIntoView({ inline: "nearest", block: "nearest" });
    });
  });

  /**
   * Pointer-based reordering. HTML5 drag-and-drop never fires on touch, so the
   * same gesture is implemented once with Pointer Events: pointer-down arms it,
   * a long press (touch) or a small move (mouse) starts the drag, and the drop
   * indicator follows whichever tab is under the pointer.
   */
  const startDrag = (event: PointerEvent, id: string) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;

    const startX = event.clientX;
    const startY = event.clientY;
    const touch = event.pointerType !== "mouse";
    let armed = false;
    let longPress: number | undefined;

    const arm = () => {
      if (armed) return;
      armed = true;
      setDragging(id);
      if (touch && navigator.vibrate) navigator.vibrate(8);
    };

    if (touch) longPress = window.setTimeout(arm, LONG_PRESS_MS);

    const onMove = (move: PointerEvent) => {
      const dx = Math.abs(move.clientX - startX);
      const dy = Math.abs(move.clientY - startY);

      if (!armed) {
        // A touch that moves before the long press is a scroll, not a drag.
        if (touch) {
          if (dx > LONG_PRESS_SLOP || dy > LONG_PRESS_SLOP) cleanup();
          return;
        }
        if (dx > DRAG_THRESHOLD) arm();
        else return;
      }

      move.preventDefault();
      const el = document.elementFromPoint(move.clientX, move.clientY)?.closest<HTMLElement>('[data-slot="tab"]');
      const targetId = el?.dataset.id;
      if (!el || !targetId || targetId === id) return;

      const rect = el.getBoundingClientRect();
      const side = move.clientX < rect.left + rect.width / 2 ? "before" : "after";
      const current = dropTarget();
      if (current?.id !== targetId || current.side !== side) setDropTarget({ id: targetId, side });
    };

    const finish = () => {
      const from = dragging();
      const target = dropTarget();
      if (from && target) moveTab(from, target.id, target.side);
      cleanup();
    };

    function cleanup() {
      if (longPress) window.clearTimeout(longPress);
      setDragging(null);
      setDropTarget(null);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", cleanup);
    }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", cleanup);
    onCleanup(cleanup);
  };

  return (
    <div data-slot="tabbar">
      <Show when={state.compact}>
        <button type="button" data-slot="tabbar-menu" aria-label="Show sidebar" onClick={toggleSidebar}>
          <Icon name="panel" size={15} />
        </button>
      </Show>

      <div
        data-slot="tabstrip"
        ref={strip}
        role="tablist"
        /*
         * A vertical wheel scrolls the strip sideways. The scrollbar is hidden
         * and a mouse has no horizontal axis, so without this the only ways to
         * reach an off-screen tab are a trackpad swipe or shift-wheel — and
         * neither is discoverable. `instant` because the strip animates its
         * programmatic scrolls, and animating every wheel tick lags behind the
         * hand.
         */
        onWheel={(event) => {
          if (!strip || event.deltaX !== 0) return;
          if (strip.scrollWidth <= strip.clientWidth) return;
          event.preventDefault();
          strip.scrollBy({ left: event.deltaY, behavior: "instant" });
        }}
      >
        <For each={state.tabs}>
          {(tab) => (
            <div
              data-slot="tab"
              data-id={tab.id}
              data-kind={tab.kind}
              data-active={state.activeTabId === tab.id ? "" : undefined}
              data-dragging={dragging() === tab.id ? "" : undefined}
              data-drop={dropTarget()?.id === tab.id ? dropTarget()!.side : undefined}
              onPointerDown={(event) => startDrag(event, tab.id)}
            >
              <button
                type="button"
                role="tab"
                data-slot="tab-trigger"
                aria-selected={state.activeTabId === tab.id}
                title={tab.kind === "file" ? tab.path : tab.name}
                onClick={() => setActiveTab(tab.id)}
                onAuxClick={(event) => {
                  if (event.button === 1) closeTab(tab.id);
                }}
              >
                <Show
                  when={tab.kind === "session" && sessionBusy(tab.id)}
                  fallback={
                    <Icon name={tab.kind === "session" ? "comment" : "file"} size={13} class="shrink-0 opacity-70" />
                  }
                >
                  <Spinner size={9} />
                </Show>
                <span class="truncate">{tab.name}</span>
                <Show when={tab.kind === "file" && commentCount(tab.id) > 0}>
                  <span data-slot="tab-badge">{commentCount(tab.id)}</span>
                </Show>
              </button>
              <button
                type="button"
                data-slot="tab-close"
                aria-label={`Close ${tab.name}`}
                onClick={() => closeTab(tab.id)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          )}
        </For>
      </div>

      <button type="button" data-slot="tab-new" aria-label="New session" title="New session" onClick={() => void newSession()}>
        <Icon name="plus" size={14} />
      </button>

      <Show when={!state.compact && state.activeSessionId && activeSessionState() !== "idle"}>
        <span data-slot="tabbar-status">
          <Spinner size={9} />
          {activeSessionState() === "tool" ? "running tools" : "working"}
        </span>
      </Show>
    </div>
  );
}
