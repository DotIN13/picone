/**
 * Dragging a file into the composer (DESIGN §57).
 *
 * Pointer events rather than HTML5 drag-and-drop, for two reasons. A `<button>`
 * with `draggable` does not reliably begin a native drag in Chrome — the press
 * is claimed for activating the button — and native drag never fires on touch
 * at all, so half the app could not do it. The tab strip already reorders this
 * way; this is the same gesture pointed somewhere else.
 *
 * It also means the thing being dragged can be drawn, which a refused native
 * drag cannot: a small label follows the pointer, so the gesture looks like
 * what it is before anything is dropped.
 */

/** Far enough to mean it, near enough not to fight a click. */
const THRESHOLD = 4;
/** A touch has to be held, or scrolling the tree would drag out of it. */
const LONG_PRESS_MS = 350;

export interface PathDrag {
  path: string;
  label: string;
  /** Where a drop counts. */
  target: string;
  onDrop: (path: string) => void;
}

/**
 * Arm a drag from a pointer-down. Returns true once it actually began, which
 * is how a caller knows to swallow the click that would otherwise follow.
 */
export function startPathDrag(event: PointerEvent, options: PathDrag): void {
  if (event.button !== 0 && event.pointerType === "mouse") return;

  const startX = event.clientX;
  const startY = event.clientY;
  const touch = event.pointerType !== "mouse";
  let ghost: HTMLElement | null = null;
  let longPress: number | undefined;

  const over = (x: number, y: number) => document.elementFromPoint(x, y)?.closest(options.target) ?? null;

  const begin = (x: number, y: number) => {
    if (ghost) return;
    ghost = document.createElement("div");
    ghost.dataset.component = "drag-ghost";
    ghost.textContent = options.label;
    document.body.appendChild(ghost);
    document.body.dataset.draggingPath = "";
    if (touch && navigator.vibrate) navigator.vibrate(8);
    place(x, y);
  };

  const place = (x: number, y: number) => {
    if (!ghost) return;
    ghost.style.transform = `translate(${x + 12}px, ${y + 12}px)`;
    const landing = over(x, y);
    ghost.dataset.overTarget = landing ? "" : undefined;
    if (landing) landing.setAttribute("data-dropping", "");
    else document.querySelector(`${options.target}[data-dropping]`)?.removeAttribute("data-dropping");
  };

  if (touch) longPress = window.setTimeout(() => begin(startX, startY), LONG_PRESS_MS);

  const onMove = (move: PointerEvent) => {
    if (!ghost) {
      const far = Math.abs(move.clientX - startX) > THRESHOLD || Math.abs(move.clientY - startY) > THRESHOLD;
      // A touch that moves before the long press is a scroll, not a drag.
      if (touch) {
        if (far) cleanup();
        return;
      }
      if (!far) return;
      begin(move.clientX, move.clientY);
    }
    move.preventDefault();
    place(move.clientX, move.clientY);
  };

  const finish = (up: PointerEvent) => {
    const landed = ghost ? over(up.clientX, up.clientY) : null;
    cleanup();
    if (landed) options.onDrop(options.path);
  };

  function cleanup() {
    if (longPress) window.clearTimeout(longPress);
    ghost?.remove();
    ghost = null;
    delete document.body.dataset.draggingPath;
    document.querySelector(`${options.target}[data-dropping]`)?.removeAttribute("data-dropping");
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", finish);
    window.removeEventListener("pointercancel", cleanup);
  }

  window.addEventListener("pointermove", onMove, { passive: false });
  window.addEventListener("pointerup", finish);
  window.addEventListener("pointercancel", cleanup);
}
