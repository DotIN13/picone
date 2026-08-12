import { createSignal, onCleanup } from "solid-js";

/** Reactive `matchMedia`. */
export function mediaQuery(query: string): () => boolean {
  const list = window.matchMedia(query);
  const [matches, setMatches] = createSignal(list.matches);
  const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
  list.addEventListener("change", onChange);
  onCleanup(() => list.removeEventListener("change", onChange));
  return matches;
}

/**
 * Layout classes. `compact` is the phone-shaped layout where the sidebar
 * becomes an overlay and dialogs become sheets; `medium` covers tablets in
 * portrait, which have room for a wider sheet but not a permanent sidebar.
 */
export const COMPACT_QUERY = "(max-width: 767px)";
export const MEDIUM_QUERY = "(min-width: 768px) and (max-width: 1023px)";

/** True on touch-first devices, where hover affordances never appear. */
export const COARSE_QUERY = "(pointer: coarse)";

/**
 * Publish the viewport's size as a plain pixel length (`--viewport-height`).
 *
 * Not a convenience: `zoom` and viewport units do not compose the same way in
 * every engine. Picone's shell is `zoom: 1.25` with `height: calc(100dvh /
 * 1.25)`, which Blink multiplies straight back to the viewport — and WebKit
 * does not, leaving every iPhone with the bottom fifth of the screen blank
 * below the composer. A plain pixel length is scaled by both.
 *
 * So the number is measured rather than computed: an off-screen probe of
 * `100dvh` sits outside the zoomed tree, where `dvh` means what it says, and
 * whatever the engine makes of it is what gets published. That also keeps it
 * tracking the browser chrome as it collapses, which is the whole point of
 * `dvh` and would be lost by reading `innerHeight` instead.
 */
export function trackViewportSize(): void {
  const probe = document.createElement("div");
  probe.setAttribute("aria-hidden", "true");
  // Fixed and hidden, so it takes part in layout and in nothing else.
  probe.style.cssText =
    "position:fixed;top:0;left:0;width:100vw;height:100dvh;visibility:hidden;pointer-events:none";
  document.body.appendChild(probe);

  const apply = () => {
    const box = probe.getBoundingClientRect();
    const root = document.documentElement.style;
    if (box.height > 0) root.setProperty("--viewport-height", `${Math.round(box.height)}px`);
    if (box.width > 0) root.setProperty("--viewport-width", `${Math.round(box.width)}px`);
  };

  apply();
  // The probe changes size for every reason the viewport does — rotation, a
  // collapsing toolbar, a resized window — so watching it needs no event list.
  const observer = new ResizeObserver(apply);
  observer.observe(probe);
  onCleanup(() => {
    observer.disconnect();
    probe.remove();
  });
}

/**
 * Below this, an occluded strip is browser chrome rather than a keyboard.
 *
 * iOS Safari's bottom bar is about 110 unzoomed pixels and every on-screen
 * keyboard is far taller, even in landscape — so the two do not overlap and a
 * single number tells them apart.
 */
export const KEYBOARD_FLOOR = 120;

/** Whether a focused element is one an on-screen keyboard would open for. */
export function isEditing(element: { tagName?: string; type?: string; isContentEditable?: boolean } | null): boolean {
  if (!element) return false;
  if (element.isContentEditable) return true;
  if (element.tagName === "TEXTAREA") return true;
  if (element.tagName !== "INPUT") return false;
  // Everything a text keyboard is *not*: these focus without one appearing.
  return !["button", "checkbox", "radio", "range", "color", "file", "submit", "reset"].includes(element.type ?? "text");
}

/**
 * How much of the viewport the on-screen keyboard is covering.
 *
 * The occluded strip is not on its own a keyboard. iOS Safari's bottom toolbar
 * takes exactly the same space out of the visual viewport, and counting it as
 * one lifted the composer clear of the bottom of the screen — a gap the size of
 * the toolbar sat under the input bar for as long as the page was open.
 *
 * Two things tell them apart, and both have to hold: a keyboard only appears
 * while something is being typed into, and it is much taller than any browser's
 * chrome.
 */
export function keyboardInset(input: {
  innerHeight: number;
  viewportHeight: number;
  offsetTop: number;
  editing: boolean;
}): number {
  if (!input.editing) return 0;
  const occluded = input.innerHeight - input.viewportHeight - input.offsetTop;
  return occluded >= KEYBOARD_FLOOR ? Math.round(occluded) : 0;
}

/**
 * iOS Safari and Android Chrome shrink the visual viewport when the on-screen
 * keyboard opens, but leave `100dvh` alone in some versions. Publishing the
 * offset as a CSS variable lets the shell sit above the keyboard either way.
 */
export function trackVisualViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;

  const apply = () => {
    const inset = keyboardInset({
      innerHeight: window.innerHeight,
      viewportHeight: viewport.height,
      offsetTop: viewport.offsetTop,
      editing: isEditing(document.activeElement as HTMLElement | null),
    });
    document.documentElement.style.setProperty("--keyboard-inset-raw", `${inset}px`);
  };

  apply();
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  // Focus is half the answer, so the events that change it recompute too —
  // otherwise the inset outlives the keyboard that justified it.
  document.addEventListener("focusin", apply);
  document.addEventListener("focusout", apply);
  onCleanup(() => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
    document.removeEventListener("focusin", apply);
    document.removeEventListener("focusout", apply);
  });
}
