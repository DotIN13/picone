import { createSignal, onCleanup } from "solid-js";

/**
 * The handle between two panes.
 *
 * Pointer events rather than mouse events, so a trackpad, a pen and a finger
 * all work from one code path, and pointer capture so a fast drag that outruns
 * the cursor keeps resizing instead of dropping the grab. Double-click resets
 * to the design width — a pane dragged to nothing is otherwise hard to get back.
 */
export function Resizer(props: {
  /** Current width in CSS pixels. */
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  /** Restored by a double-click. */
  reset: number;
  label: string;
}) {
  const [dragging, setDragging] = createSignal(false);

  let startX = 0;
  let startValue = 0;
  let zoom = 1;

  // Whole pixels: dividing by the zoom otherwise persists 458.28571428px, and
  // a fractional width lands text on half a pixel for no benefit.
  const clamp = (value: number) => Math.round(Math.min(props.max, Math.max(props.min, value)));

  /**
   * How many physical pixels one CSS pixel of this pane occupies.
   *
   * The interface scale is a CSS `zoom`, so a pointer that travels 140 physical
   * pixels has crossed only 100 pixels of a pane at 140% — and a width set from
   * the raw delta slides out from under the cursor by the difference.
   */
  const zoomOf = (element: HTMLElement) =>
    element.currentCSSZoom ||
    Number(getComputedStyle(document.documentElement).getPropertyValue("--ui-scale")) ||
    1;

  const onPointerDown = (event: PointerEvent) => {
    // Ignore anything but the primary button, so a right-click never grabs.
    if (event.button !== 0) return;
    if (!(event.currentTarget instanceof HTMLElement)) return;
    event.preventDefault();
    startX = event.clientX;
    startValue = props.value;
    // Sampled once: it cannot change mid-drag, and reading layout on every
    // move would be a forced reflow per frame.
    zoom = zoomOf(event.currentTarget);
    setDragging(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!dragging()) return;
    props.onChange(clamp(startValue + (event.clientX - startX) / zoom));
  };

  const stop = (event: PointerEvent) => {
    if (!dragging()) return;
    setDragging(false);
    event.currentTarget instanceof HTMLElement && event.currentTarget.releasePointerCapture(event.pointerId);
  };

  // The keyboard gets the same control, which is also what makes the handle
  // reachable at all for anyone not using a pointer.
  const onKeyDown = (event: KeyboardEvent) => {
    const step = event.shiftKey ? 32 : 8;
    if (event.key === "ArrowLeft") props.onChange(clamp(props.value - step));
    else if (event.key === "ArrowRight") props.onChange(clamp(props.value + step));
    else if (event.key === "Home") props.onChange(props.reset);
    else return;
    event.preventDefault();
  };

  onCleanup(() => setDragging(false));

  return (
    <div
      data-slot="resizer"
      data-dragging={dragging() ? "" : undefined}
      role="separator"
      aria-orientation="vertical"
      aria-label={props.label}
      aria-valuenow={Math.round(props.value)}
      aria-valuemin={props.min}
      aria-valuemax={props.max}
      tabindex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={stop}
      onPointerCancel={stop}
      onDblClick={() => props.onChange(props.reset)}
      onKeyDown={onKeyDown}
    />
  );
}
