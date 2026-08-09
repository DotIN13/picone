import { randomUUID } from "node:crypto";
import type { ExtensionUiAnswer, ExtensionUiPrompt, ExtensionUiUpdate } from "@picone/protocol";

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

export interface ExtensionUiHooks {
  /** Push a blocking prompt to the browser. */
  prompt(prompt: ExtensionUiPrompt): void;
  /** Tell the browser a prompt is no longer waiting (timeout, abort, dispose). */
  closePrompt(id: string): void;
  /** Push a fire-and-forget surface update. */
  update(update: ExtensionUiUpdate): void;
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
 * (working indicator, custom header/footer, raw input, component widgets) have
 * no web equivalent and are deliberate no-ops, exactly as they are in RPC mode.
 */
export class ExtensionUiBridge {
  private readonly pending = new Map<string, (answer: ExtensionUiAnswer) => void>();

  constructor(private readonly hooks: ExtensionUiHooks) {}

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
  }

  get pendingCount(): number {
    return this.pending.size;
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
        // Component factories are TUI-only; RPC mode drops them too.
        if (content === undefined || Array.isArray(content)) {
          bridge.hooks.update({
            method: "setWidget",
            key,
            lines: content as string[] | undefined,
            placement: options?.placement,
          });
        }
      },

      setTitle: (title: string) => bridge.hooks.update({ method: "setTitle", title }),

      setEditorText: (text: string) => bridge.hooks.update({ method: "setEditorText", text }),
      pasteToEditor: (text: string) => bridge.hooks.update({ method: "setEditorText", text }),
      getEditorText: () => bridge.hooks.editorText(),

      // --- terminal-only, intentionally inert ---
      //
      // Every member of Pi's `ExtensionUIContext` is present even when it does
      // nothing. An absent method is not a graceful degradation: the extension
      // throws `ctx.ui.x is not a function` and its whole command fails.
      onTerminalInput: () => () => {},
      setWorkingMessage: () => {},
      setWorkingVisible: () => {},
      setWorkingIndicator: () => {},
      setHiddenThinkingLabel: () => {},
      setFooter: () => {},
      setHeader: () => {},
      setEditorComponent: () => {},
      getEditorComponent: () => undefined,
      addAutocompleteProvider: () => {},
      custom: async () => undefined,
      overlay: async () => undefined,

      // Tool-output folding is a TUI affordance; the web view always expands.
      getToolsExpanded: () => true,
      setToolsExpanded: () => {},

      // Theming is Picone's own concern, not the TUI theme registry's.
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ ok: false as const, error: "Themes are controlled by the Picone UI" }),
    };
  }
}
