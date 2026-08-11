/**
 * Rendering Pi's *component* widgets to lines, so they survive the trip to a
 * browser (DESIGN §55).
 *
 * `ExtensionUIContext.setWidget` takes either an array of strings or a factory,
 * `(tui, theme) => { render(width): string[] }`. The array form is already a
 * web surface. The factory form was written for the TUI, and Picone used to
 * drop it — which is why the `rpiv-todo` extension, whose entire display is a
 * factory widget, showed nothing at all here while working in the terminal.
 *
 * A factory is not really terminal-only, though. It asks for a width and hands
 * back lines; a terminal is just the caller that happened to be asking. So this
 * asks on the browser's behalf, with a plain-text theme in place of the ANSI
 * one, and forwards the lines to the same place the array form goes.
 */

/** Text styling, as Pi's `Theme` exposes it — every method a pass-through. */
interface PlainTheme {
  fg(color: string, text: string): string;
  bg(color: string, text: string): string;
  bold(text: string): string;
  italic(text: string): string;
  underline(text: string): string;
  inverse(text: string): string;
  strikethrough(text: string): string;
  getFgAnsi(color: string): string;
  getBgAnsi(color: string): string;
  getColorMode(): string;
  getThinkingBorderColor(level?: unknown): string;
  getBashModeBorderColor(): string;
}

/**
 * A theme that styles nothing.
 *
 * Colour is the browser's job, and it has the real thing: CSS. Emitting ANSI
 * here would only mean stripping it again downstream, and a half-stripped
 * escape sequence in a `<pre>` is worse than no colour at all. Glyphs survive —
 * the todo list's `○ ◐ ✓` carry the status without needing the colour that
 * accompanies them in the terminal.
 */
export const plainTheme: PlainTheme = {
  fg: (_color, text) => text,
  bg: (_color, text) => text,
  bold: (text) => text,
  italic: (text) => text,
  underline: (text) => text,
  inverse: (text) => text,
  strikethrough: (text) => text,
  getFgAnsi: () => "",
  getBgAnsi: () => "",
  getColorMode: () => "none",
  getThinkingBorderColor: () => "",
  getBashModeBorderColor: () => "",
};

/**
 * The width widgets are rendered at.
 *
 * A browser has no column count to report, and the factory contract insists on
 * one. Generous rather than accurate: extensions use the width to *truncate*,
 * not to pad, so too large only means nothing is cut, and the browser wraps
 * what it is given. Too small would lose text permanently, before it was ever
 * sent.
 */
export const WIDGET_WIDTH = 160;

/** What a factory returns. `render` is required; the rest are optional. */
interface WidgetComponent {
  render(width: number): string[];
  invalidate?(): void;
  dispose?(): void;
}

type WidgetFactory = (tui: { requestRender(): void }, theme: PlainTheme) => WidgetComponent;

/**
 * A live factory widget: the component, and the way it asks to be redrawn.
 *
 * Extensions register once and then call `tui.requestRender()` whenever their
 * data changes — the todo overlay does this on every completed `todo` tool
 * call. So the component is kept, and each request re-renders it and pushes the
 * result. Nothing is diffed here; the lines are small and the browser reconciles.
 */
export class FactoryWidget {
  private readonly component: WidgetComponent;

  constructor(factory: WidgetFactory, private readonly onLines: (lines: string[]) => void) {
    this.component = factory({ requestRender: () => this.push() }, plainTheme);
  }

  /** Render now and hand the lines over. */
  push(): void {
    this.onLines(this.render());
  }

  private render(): string[] {
    try {
      return this.component.render(WIDGET_WIDTH);
    } catch {
      // A widget that throws is a broken widget, not a broken session: the
      // extension keeps working, and the panel simply stays empty.
      return [];
    }
  }

  dispose(): void {
    this.component.dispose?.();
  }
}

/**
 * The keybindings manager a `custom` factory is handed.
 *
 * Components consult it to ask whether a keystroke is already claimed by an app
 * binding before acting on it themselves. Picone has no terminal keymap, so
 * nothing is claimed and the component keeps every key — which is the right
 * answer for a dialog that owns the keyboard for as long as it is open.
 */
export const keybindingsStub = {
  matches: () => false,
  get: () => undefined,
  getBinding: () => undefined,
  getAll: () => [],
  getKeybindings: () => ({}),
  on: () => () => {},
  off: () => {},
};
