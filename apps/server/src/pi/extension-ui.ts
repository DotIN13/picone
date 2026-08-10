import { randomUUID } from "node:crypto";
import type { ExtensionUiAnswer, ExtensionUiPrompt, ExtensionUiUpdate } from "@picone/protocol";
import { FactoryWidget, WIDGET_WIDTH, keybindingsStub, plainTheme } from "./widget-render.ts";

/**
 * Options Pi passes to the blocking dialog methods.
 * Both are advisory: on abort or timeout we resolve with the caller's default
 * rather than rejecting, so an extension can never wedge a session.
 */
interface DialogOptions {
  timeout?: number;
  signal?: AbortSignal;
}

/** `Omit` over a union collapses it; this keeps each member intact. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

type PromptDraft = DistributiveOmit<ExtensionUiPrompt, "id">;

/**
 * What Pi hands a footer factory as its third argument.
 *
 * Present so a factory that destructures it works rather than throwing; the
 * values it exposes are terminal-footer concerns that Picone shows elsewhere or
 * not at all, so they answer emptily rather than wrongly. `onBranchChange`
 * returns its unsubscribe, as the real one does.
 */
const footerData = {
  getGitBranch: () => null,
  getExtensionStatuses: () => new Map<string, string>(),
  getAvailableProviderCount: () => 0,
  onBranchChange: () => () => {},
};

export interface ExtensionUiHooks {
  /** Push a blocking prompt to the browser. */
  prompt(prompt: ExtensionUiPrompt): void;
  /** Tell the browser a prompt is no longer waiting (timeout, abort, dispose). */
  closePrompt(id: string): void;
  /** Push a fire-and-forget surface update. */
  update(update: ExtensionUiUpdate): void;
  /** Redraw an open `custom` component. */
  frame(id: string, lines: string[]): void;
  /** Surface a message in the transcript. */
  notify(message: string, level: "info" | "warn" | "error"): void;
  /** Current composer contents, mirrored from the browser. */
  editorText(): string;
}

/**
 * Pi's extension UI surface, implemented against the browser.
 *
 * This is the same contract `runRpcMode` implements over stdio: four blocking
 * dialogs and a handful of fire-and-forget surfaces. Terminal-only affordances
 * (working indicator, custom header/footer, raw input) have no web equivalent
 * and are deliberate no-ops, exactly as they are in RPC mode.
 *
 * Component widgets are the exception, and used to be in that list. A factory
 * widget only asks for lines at a width, which a browser can answer as well as
 * a terminal — see widget-render.ts. Treating it as terminal-only meant any
 * extension that displays through a widget displayed nothing here at all.
 */
export class ExtensionUiBridge {
  private readonly pending = new Map<string, (answer: ExtensionUiAnswer) => void>();
  /** Live factory widgets, so a redraw request can reach the right component. */
  private readonly widgets = new Map<string, FactoryWidget>();
  /**
   * Whether tool output starts expanded. Held here because `getToolsExpanded`
   * is synchronous — it cannot wait for the browser to answer — so the server
   * owns the value and the browser is told when it changes.
   */
  private toolsExpanded = false;
  /** Open `custom` components, so a keystroke can reach the right one. */
  private readonly customs = new Map<string, { handleInput?(data: string): void; dispose?(): void }>();

  constructor(private readonly hooks: ExtensionUiHooks) {}

  /**
   * A keystroke for an open `custom` component.
   *
   * Already encoded as the bytes a terminal would have sent, because that is
   * what the component's `handleInput` parses — translating a browser key event
   * is the browser's job, where the event actually is.
   */
  key(id: string, data: string): void {
    try {
      this.customs.get(id)?.handleInput?.(data);
    } catch {
      // A component that throws on a keystroke should not take the session
      // down; it stays open and the key is simply lost.
    }
  }

  /** Resolve a prompt from the browser. Unknown ids are stale and ignored. */
  answer(answer: ExtensionUiAnswer): void {
    const resolve = this.pending.get(answer.id);
    if (!resolve) return;
    this.pending.delete(answer.id);
    resolve(answer);
  }

  /** Cancel everything still waiting — used when the session goes away. */
  dispose(): void {
    for (const [id, resolve] of this.pending) {
      this.hooks.closePrompt(id);
      resolve({ id, cancelled: true });
    }
    this.pending.clear();

    for (const widget of this.widgets.values()) widget.dispose();
    this.widgets.clear();

    for (const component of this.customs.values()) component.dispose?.();
    this.customs.clear();
  }

  get pendingCount(): number {
    return this.pending.size;
  }

  /**
   * A header or footer, which Pi takes only as a component factory.
   *
   * The same shape as a factory widget and rendered by the same machinery; the
   * only difference is where the lines land. The footer factory is called with
   * a third argument, a data provider, so one is supplied — an extension that
   * destructures it should find the fields it expects rather than a crash.
   */
  private chrome(slot: "header" | "footer", factory: unknown): void {
    const key = `chrome:${slot}`;
    this.widgets.get(key)?.dispose();
    this.widgets.delete(key);

    const send = (lines: string[] | undefined) => this.hooks.update({ method: "setChrome", slot, lines });
    if (typeof factory !== "function") {
      send(undefined);
      return;
    }

    const widget = new FactoryWidget(
      (tui, theme) => (factory as (t: unknown, th: unknown, data: unknown) => never)(tui, theme, footerData),
      send,
    );
    this.widgets.set(key, widget);
    widget.push();
  }

  private ask<T>(
    prompt: PromptDraft,
    parse: (answer: ExtensionUiAnswer) => T,
    fallback: T,
    options?: DialogOptions,
  ): Promise<T> {
    const id = randomUUID();

    return new Promise<T>((resolve) => {
      let timer: NodeJS.Timeout | undefined;

      const settle = (value: T) => {
        if (!this.pending.delete(id)) return;
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        this.hooks.closePrompt(id);
        resolve(value);
      };

      function onAbort() {
        settle(fallback);
      }

      this.pending.set(id, (answer) => {
        if (timer) clearTimeout(timer);
        options?.signal?.removeEventListener("abort", onAbort);
        resolve(parse(answer));
      });

      if (options?.signal) {
        if (options.signal.aborted) {
          settle(fallback);
          return;
        }
        options.signal.addEventListener("abort", onAbort, { once: true });
      }

      if (options?.timeout) timer = setTimeout(() => settle(fallback), options.timeout);

      this.hooks.prompt({ ...prompt, id } as ExtensionUiPrompt);
    });
  }

  /**
   * Run a `ui.custom` component against the browser.
   *
   * Three ways out, and all of them settle the promise exactly once: the
   * component calls `done`, the human dismisses the dialog, or the session goes
   * away. An extension awaiting this must never be left waiting — before this
   * existed the call returned `undefined` immediately, which at least did not
   * hang, and hanging would be a worse trade than not supporting it at all.
   */
  private async runCustom<T>(factory: unknown): Promise<T | undefined> {
    if (typeof factory !== "function") return undefined;
    const id = randomUUID();

    return new Promise<T | undefined>((resolve) => {
      let settled = false;
      const settle = (value: T | undefined) => {
        if (settled) return;
        settled = true;
        this.customs.get(id)?.dispose?.();
        this.customs.delete(id);
        this.pending.delete(id);
        this.hooks.closePrompt(id);
        resolve(value);
      };

      // The dialog's own dismissal arrives through the ordinary answer path.
      this.pending.set(id, () => settle(undefined));

      const draw = (component: { render(width: number): string[] }) => {
        try {
          return component.render(WIDGET_WIDTH);
        } catch {
          return [];
        }
      };

      const tui = {
        requestRender: () => {
          const component = this.customs.get(id) as { render(width: number): string[] } | undefined;
          if (component) this.hooks.frame(id, draw(component));
        },
      };

      void (async () => {
        try {
          const made = await (factory as (t: unknown, th: unknown, kb: unknown, done: (r: T) => void) => unknown)(
            tui,
            plainTheme,
            keybindingsStub,
            (result: T) => settle(result),
          );
          const component = made as { render(width: number): string[]; handleInput?(d: string): void };
          if (settled) {
            (component as { dispose?(): void }).dispose?.();
            return;
          }
          this.customs.set(id, component as never);
          this.hooks.prompt({ id, method: "custom", lines: draw(component) });
        } catch {
          // A component that will not even construct is not worth a dialog.
          settle(undefined);
        }
      })();
    });
  }

  /**
   * The object handed to `session.bindExtensions({ uiContext })`. Pi's
   * `ExtensionUIContext` includes TUI-typed members we cannot satisfy, so the
   * call site casts; every method Pi actually invokes is implemented here.
   */
  context() {
    const bridge = this;
    return {
      // --- blocking dialogs ---
      select: (title: string, options: string[], opts?: DialogOptions) =>
        bridge.ask<string | undefined>(
          { method: "select", title, options },
          (answer) => ("value" in answer ? answer.value : undefined),
          undefined,
          opts,
        ),

      confirm: (title: string, message: string, opts?: DialogOptions) =>
        bridge.ask<boolean>(
          { method: "confirm", title, message },
          (answer) => ("confirmed" in answer ? answer.confirmed : false),
          false,
          opts,
        ),

      input: (title: string, placeholder?: string, opts?: DialogOptions) =>
        bridge.ask<string | undefined>(
          { method: "input", title, placeholder },
          (answer) => ("value" in answer ? answer.value : undefined),
          undefined,
          opts,
        ),

      editor: (title: string, prefill?: string) =>
        bridge.ask<string | undefined>(
          { method: "editor", title, prefill },
          (answer) => ("value" in answer ? answer.value : undefined),
          undefined,
        ),

      // --- fire and forget ---
      notify: (message: string, type?: "info" | "warning" | "error") =>
        bridge.hooks.notify(message, type === "warning" ? "warn" : type === "error" ? "error" : "info"),

      setStatus: (key: string, text: string | undefined) =>
        bridge.hooks.update({ method: "setStatus", key, text }),

      setWidget: (key: string, content: unknown, options?: { placement?: "aboveEditor" | "belowEditor" }) => {
        const placement = options?.placement;
        const send = (lines: string[] | undefined) =>
          bridge.hooks.update({ method: "setWidget", key, lines, placement });

        // Registering under a key replaces whatever held it, as it does in Pi.
        bridge.widgets.get(key)?.dispose();
        bridge.widgets.delete(key);

        if (content === undefined || Array.isArray(content)) {
          send(content as string[] | undefined);
          return;
        }

        /*
         * The factory form. RPC mode drops this and so did we, which left any
         * extension whose display *is* a widget — the todo overlay is the one
         * that surfaced it — visible in the terminal and invisible here. It is
         * only a request for lines at a given width, so we can answer it.
         */
        if (typeof content === "function") {
          const widget = new FactoryWidget(content as never, send);
          bridge.widgets.set(key, widget);
          widget.push();
        }
      },

      setTitle: (title: string) => bridge.hooks.update({ method: "setTitle", title }),

      setEditorText: (text: string) => bridge.hooks.update({ method: "setEditorText", text }),
      pasteToEditor: (text: string) => bridge.hooks.update({ method: "setEditorText", text }),
      getEditorText: () => bridge.hooks.editorText(),

      // --- the row shown while the agent works ---
      //
      // Picone draws one too, so all three of these describe something real
      // here rather than a terminal affordance.
      setWorkingMessage: (message?: string) => bridge.hooks.update({ method: "setWorkingMessage", message }),
      setWorkingVisible: (visible: boolean) => bridge.hooks.update({ method: "setWorkingVisible", visible }),
      setWorkingIndicator: (options?: { frames?: string[] }) =>
        bridge.hooks.update({ method: "setWorkingIndicator", frames: options?.frames }),

      setHiddenThinkingLabel: (label?: string) =>
        bridge.hooks.update({ method: "setHiddenThinkingLabel", label }),

      // --- header and footer ---
      //
      // Factories, like the second form of setWidget, and rendered the same
      // way. The footer factory is additionally handed a data provider; we pass
      // one that answers what we can and nothing where we cannot, rather than
      // omitting it and having the factory throw on arity.
      setFooter: (factory?: unknown) => bridge.chrome("footer", factory),
      setHeader: (factory?: unknown) => bridge.chrome("header", factory),

      // --- tool output folding ---
      //
      // A real setting here, not a TUI one: it decides whether a tool call in
      // the transcript starts open. Held on the server so the synchronous
      // getter can answer, and mirrored to the browser so it can act on it.
      getToolsExpanded: () => bridge.toolsExpanded,
      setToolsExpanded: (expanded: boolean) => {
        bridge.toolsExpanded = expanded;
        bridge.hooks.update({ method: "setToolsExpanded", expanded });
      },

      // --- theming ---
      //
      // `theme` is a property rather than a method, and extensions reach for it
      // to style their own output. Returning the plain-text theme keeps that
      // working — styling is a no-op and the text arrives intact. It used to be
      // absent entirely, which would throw on the first `ctx.ui.theme.fg(...)`.
      get theme() {
        return plainTheme;
      },
      getAllThemes: () => [{ name: "picone", path: undefined }],
      getTheme: () => plainTheme,
      setTheme: () => ({ success: false, error: "Themes are controlled by the Picone UI" }),

      // --- genuinely terminal-only, intentionally inert ---
      //
      // Every member of Pi's `ExtensionUIContext` is present even when it does
      // nothing. An absent method is not a graceful degradation: the extension
      // throws `ctx.ui.x is not a function` and its whole command fails.
      //
      // What is left here needs a terminal specifically: raw keystrokes, and
      // replacing the editor with a TUI component that reads them.
      onTerminalInput: () => () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      addAutocompleteProvider: () => {},
      overlay: async () => undefined,

      // --- an interactive component ---
      //
      // `ui.custom` is a screen the extension draws and drives: it renders
      // lines and consumes keystrokes until it calls `done`. That is a terminal
      // *idiom*, but not a terminal requirement — lines can be shown in a
      // dialog and keys can be forwarded to it. The component runs here, where
      // it already is; only the pixels and the keystrokes cross the wire.
      custom: <T,>(factory: unknown, _options?: unknown): Promise<T | undefined> =>
        bridge.runCustom<T>(factory),
    };
  }
}
