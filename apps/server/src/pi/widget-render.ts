import type { WidgetLine, WidgetSpan } from "@picone/protocol";

/**
 * Rendering Pi's *component* widgets for a browser (DESIGN §55).
 *
 * `ExtensionUIContext.setWidget` takes either an array of strings or a factory,
 * `(tui, theme) => { render(width): string[] }`. The factory form was written
 * for a terminal, and it hands back exactly what a terminal wants: text with the
 * layout baked in and the meaning carried by colour.
 *
 * Printing that into a `<pre>` is faithful and looks like it. What this does
 * instead is *ask the widget what it meant*. Every TUI draws through the theme —
 * `theme.fg("success", "✓")`, `theme.fg("dim", hint)` — and the theme is ours to
 * supply. So it emits ANSI carrying the role name rather than a colour, and the
 * rendered lines are parsed back into spans that say `success` and `dim`. The
 * browser then styles them, and nothing has to guess what a glyph implies.
 *
 * Why ANSI rather than markers of our own: `visibleWidth()` in pi-tui strips
 * ANSI before measuring, and `truncateToWidth` is built on it — so the widget's
 * own truncation, padding and right-alignment stay correct. Any other marker
 * would count towards the width and pull its layout apart.
 */

/** Text styling, as Pi's `Theme` exposes it. */
interface MarkingTheme {
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

const ESC = String.fromCharCode(27);

/**
 * A colour index per role, allocated as roles are seen.
 *
 * The number is meaningless as a colour — it is a handle we hand out and read
 * back, so the role that comes out is exactly the role that went in. A real
 * theme's palette would have to be matched by RGB, which is guessing with extra
 * steps.
 */
const roleCodes = new Map<string, number>();
const codeRoles = new Map<number, string>();
/** 16 upwards: below that are the terminal's own eight, which extensions use raw. */
let nextCode = 16;

function codeFor(role: string): number {
  const existing = roleCodes.get(role);
  if (existing !== undefined) return existing;
  const code = nextCode++;
  roleCodes.set(role, code);
  codeRoles.set(code, role);
  return code;
}

const fgOpen = (role: string) => `${ESC}[38;5;${codeFor(role)}m`;
const bgOpen = (role: string) => `${ESC}[48;5;${codeFor(role)}m`;

/** The theme handed to every widget factory. */
export const markingTheme: MarkingTheme = {
  fg: (color, text) => `${fgOpen(color)}${text}${ESC}[39m`,
  bg: (color, text) => `${bgOpen(color)}${text}${ESC}[49m`,
  bold: (text) => `${ESC}[1m${text}${ESC}[22m`,
  italic: (text) => `${ESC}[3m${text}${ESC}[23m`,
  underline: (text) => `${ESC}[4m${text}${ESC}[24m`,
  inverse: (text) => text,
  strikethrough: (text) => `${ESC}[9m${text}${ESC}[29m`,
  // Handed out so a widget that builds its own string still carries the role.
  getFgAnsi: (color) => fgOpen(color),
  getBgAnsi: (color) => bgOpen(color),
  getColorMode: () => "256",
  getThinkingBorderColor: () => fgOpen("accent"),
  getBashModeBorderColor: () => fgOpen("accent"),
};

/** Kept for callers that only want the text — the `custom` dialog's fallback. */
export const plainTheme = markingTheme;

/** `ESC [ … m`, the only sequence a theme produces. */
const SGR = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

/**
 * One rendered line, split into spans by the roles the widget declared.
 *
 * Codes we did not hand out are dropped rather than guessed at — an extension
 * writing its own ANSI gets its text through with no role, which is the same
 * outcome as never having styled it.
 */
export function parseSpans(line: string): WidgetLine {
  const spans: WidgetSpan[] = [];
  let role: string | undefined;
  let bold = false;
  let at = 0;

  const push = (text: string) => {
    if (text === "") return;
    const last = spans[spans.length - 1];
    // Adjacent text with the same styling is one span, so a widget that opens
    // and closes a colour around every character does not produce hundreds.
    if (last && last.role === role && (last.bold ?? false) === bold) last.text += text;
    else spans.push({ text, ...(role ? { role } : {}), ...(bold ? { bold } : {}) });
  };

  SGR.lastIndex = 0;
  for (let match = SGR.exec(line); match !== null; match = SGR.exec(line)) {
    push(line.slice(at, match.index));
    at = match.index + match[0].length;

    const params = (match[1] ?? "").split(";").filter((p) => p !== "");
    for (let i = 0; i < params.length; i++) {
      const code = Number(params[i]);
      if (code === 0) {
        role = undefined;
        bold = false;
      } else if (code === 1) bold = true;
      else if (code === 22) bold = false;
      else if (code === 39 || code === 49) role = undefined;
      else if ((code === 38 || code === 48) && params[i + 1] === "5") {
        role = codeRoles.get(Number(params[i + 2]));
        i += 2;
      }
    }
  }
  push(line.slice(at));

  return spans;
}

export function parseLines(lines: string[]): WidgetLine[] {
  return lines.map(parseSpans);
}

/** Plain text, for a widget that supplied strings rather than a factory. */
export function plainLines(lines: string[]): WidgetLine[] {
  return lines.map((text) => (text === "" ? [] : [{ text }]));
}

/**
 * The width widgets are rendered at.
 *
 * Generous, because the browser re-lays out what comes back: a narrow width
 * would make the widget truncate text that had room to wrap. Too wide costs
 * nothing now that nothing downstream depends on the column arithmetic.
 */
export const WIDGET_WIDTH = 160;

/** What a factory returns. `render` is required; the rest are optional. */
interface WidgetComponent {
  render(width: number): string[];
  invalidate?(): void;
  dispose?(): void;
}

/**
 * How many rows a factory is told it has, when it asks.
 *
 * Nothing here scrolls by rows, so this is only ever an answer to "how much
 * room do I have". 32 because that is the number `pi-subagents` falls back to
 * when the terminal will not say — borrowing an extension's own default is
 * better than inventing one.
 */
export const WIDGET_ROWS = 32;

/**
 * What Picone hands a factory in place of the TUI.
 *
 * `requestRender` is the whole contract as far as drawing goes, but a factory
 * may also *measure* — `tui.terminal.columns`, mostly — and a stub that omits
 * `terminal` turns that into a `TypeError` inside a render we deliberately
 * try/catch. The widget then draws nothing, with nothing anywhere to say why:
 * exactly the silent invisibility that the factory form itself used to have,
 * one level down. `@tintinweb/pi-tasks` reads `columns` on every render and is
 * how we found it. So answer the question, in the same generous units as
 * `WIDGET_WIDTH`.
 */
export const tuiStub = (requestRender: () => void) => ({
  requestRender,
  terminal: { columns: WIDGET_WIDTH, rows: WIDGET_ROWS },
});

type WidgetFactory = (tui: ReturnType<typeof tuiStub>, theme: MarkingTheme) => WidgetComponent;

/**
 * A live factory widget: the component, and the way it asks to be redrawn.
 *
 * Extensions register once and then call `tui.requestRender()` whenever their
 * data changes — the todo overlay does this on every completed `todo` call. So
 * the component is kept, and each request re-renders it and pushes the result.
 */
export class FactoryWidget {
  private readonly component: WidgetComponent;

  constructor(factory: WidgetFactory, private readonly onLines: (lines: WidgetLine[]) => void) {
    this.component = factory(tuiStub(() => this.push()), markingTheme);
  }

  /** Render now and hand the spans over. */
  push(): void {
    this.onLines(this.render());
  }

  private render(): WidgetLine[] {
    try {
      return parseLines(this.component.render(WIDGET_WIDTH));
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
