import { Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { state } from "../store.ts";
import { Icon } from "./ui/icon.tsx";

/**
 * A fenced ```mermaid block, drawn (DESIGN §51).
 *
 * mermaid is by a wide margin the heaviest thing this app can load — larger
 * than the rest of the bundle put together — so it is imported the first time a
 * diagram is actually on screen and never otherwise. Most sessions never
 * mention one and should not pay for it.
 *
 * The source is always one click away. A diagram that fails to parse is a
 * common enough outcome with generated Mermaid that hiding the text would be
 * hiding the only useful thing left.
 */

type Mermaid = typeof import("mermaid")["default"];

let loading: Promise<Mermaid> | undefined;

/** One instance for the page: initialising per diagram would re-register everything. */
function mermaid(theme: "light" | "dark"): Promise<Mermaid> {
  loading ??= import("mermaid").then((module) => {
    module.default.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
      // Without this, a diagram that fails to parse is not merely a rejected
      // promise: mermaid draws a bomb and the words "Syntax error in text"
      // straight into the document, outside our tree and at whatever size it
      // likes. We report the parse error ourselves, in the block it came from.
      suppressErrorRendering: true,
    });
    return module.default;
  });
  return loading;
}

/** Ids must be unique per render or mermaid reuses a stale definition. */
let counter = 0;

export function MermaidBlock(props: { code: string }) {
  const [svg, setSvg] = createSignal<string | null>(null);
  const [error, setError] = createSignal<string | null>(null);
  const [showSource, setShowSource] = createSignal(false);
  const [near, setNear] = createSignal(false);

  let host: HTMLDivElement | undefined;

  // On mount, not in the ref: a ref runs before the element is in the document
  // and the observer would not fire until an unrelated layout change.
  onMount(() => {
    if (!host || !("IntersectionObserver" in window)) {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        setNear(true);
        observer.disconnect();
      },
      { rootMargin: "400px 0px" },
    );
    observer.observe(host);
    onCleanup(() => observer.disconnect());
  });

  createEffect(() => {
    if (!near()) return;
    const code = props.code;
    const theme = state.colorScheme;

    let cancelled = false;
    onCleanup(() => {
      cancelled = true;
    });

    void (async () => {
      try {
        const instance = await mermaid(theme);
        // `render` returns a string rather than touching the document, which is
        // why this can be awaited and then dropped if the block has gone.
        const { svg: rendered } = await instance.render(`mermaid-${++counter}`, code);
        if (!cancelled) {
          setSvg(rendered);
          setError(null);
        }
      } catch (err) {
        if (cancelled) return;
        setError((err as Error).message || "diagram could not be drawn");
        setShowSource(true);
      }
    })();
  });

  return (
    <div data-component="mermaid" ref={host}>
      <div data-slot="mermaid-bar">
        <span data-slot="mermaid-label">
          <Icon name="workflow" size={11} />
          diagram
        </span>
        <button type="button" data-slot="mermaid-toggle" onClick={() => setShowSource((v) => !v)}>
          {showSource() ? "Show diagram" : "Show source"}
        </button>
      </div>

      <Show when={error()}>
        {(message) => (
          <div data-slot="mermaid-error">
            <Icon name="alert" size={11} />
            {message()}
          </div>
        )}
      </Show>

      <Show when={!showSource()} fallback={<pre data-slot="mermaid-source">{props.code}</pre>}>
        {/* mermaid sanitizes its own output at securityLevel strict, and the
            markup is an SVG it generated rather than anything a model wrote. */}
        <Show when={svg()} fallback={<div data-slot="mermaid-pending">drawing…</div>}>
          {(markup) => <div data-slot="mermaid-canvas" innerHTML={markup()} />}
        </Show>
      </Show>
    </div>
  );
}
