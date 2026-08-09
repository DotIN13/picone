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
 * iOS Safari and Android Chrome shrink the visual viewport when the on-screen
 * keyboard opens, but leave `100dvh` alone in some versions. Publishing the
 * offset as a CSS variable lets the shell sit above the keyboard either way.
 */
export function trackVisualViewport(): void {
  const viewport = window.visualViewport;
  if (!viewport) return;

  const apply = () => {
    // How much of the layout viewport the keyboard (or a pinch) is covering.
    const occluded = Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop);
    document.documentElement.style.setProperty("--keyboard-inset", `${Math.round(occluded)}px`);
  };

  apply();
  viewport.addEventListener("resize", apply);
  viewport.addEventListener("scroll", apply);
  onCleanup(() => {
    viewport.removeEventListener("resize", apply);
    viewport.removeEventListener("scroll", apply);
  });
}
