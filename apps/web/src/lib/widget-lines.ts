import type { WidgetLine, WidgetSpan } from "@picone/protocol";

/**
 * The last thing a terminal widget encodes in characters: its shape (§55).
 *
 * Meaning already arrived as roles — the widget declared them through the theme
 * and the server read them back, so nothing here guesses what `✓` implies. What
 * is still drawn rather than declared is *structure*: depth as `├─ └─ │`, or as
 * leading spaces. Those are unambiguous, so they can be read off and turned
 * into real indentation.
 *
 * The glyphs themselves are dropped once their depth is taken; keeping them
 * would draw a second tree beside the one the layout already shows.
 */

export type WidgetRow = { kind: "gap" } | { kind: "row"; depth: number; heading: boolean; spans: WidgetLine };

/**
 * Everything a line spends on saying where it sits: the `│` columns still open
 * above it, the `├─ ` or `└─ ` branch if it has one, or just spaces.
 */
const PREFIX = /^([\s│|]*(?:[├└][─-]*[ ]?)?)/;
/** Box drawing, which is how a widget says it indents three columns at a time. */
const TREE_GLYPH = /[│|├└]/;

const textOf = (spans: WidgetLine) => spans.map((span) => span.text).join("");

/** Drop `count` characters from the front, across as many spans as it takes. */
function dropLeading(spans: WidgetLine, count: number): WidgetLine {
  const out: WidgetSpan[] = [];
  let left = count;
  for (const span of spans) {
    if (left <= 0) {
      out.push(span);
      continue;
    }
    if (span.text.length <= left) {
      left -= span.text.length;
      continue;
    }
    out.push({ ...span, text: span.text.slice(left) });
    left = 0;
  }
  return out;
}

/**
 * Drop the padding a terminal adds on the right.
 *
 * Widgets render into a fixed width and pad every line out to it, which in a
 * terminal is invisible and here would be a line of blanks stretching the row
 * far past its text.
 */
function dropTrailing(spans: WidgetLine): WidgetLine {
  const out = spans.slice();
  while (out.length > 0) {
    const last = out[out.length - 1]!;
    const trimmed = last.text.replace(/\s+$/, "");
    if (trimmed === last.text) break;
    if (trimmed === "") out.pop();
    else {
      out[out.length - 1] = { ...last, text: trimmed };
      break;
    }
  }
  return out;
}

export function parseWidgetRows(lines: WidgetLine[]): WidgetRow[] {
  const rows: WidgetRow[] = [];
  let seenText = false;

  const texts = lines.map(textOf);
  /*
   * One indent unit for the whole widget, so a branch, the `│` under it and a
   * bare continuation all land in the same column — as they did in the
   * terminal. A widget drawing a tree spends three columns per level (`├─ `);
   * one indenting with spaces alone conventionally spends two.
   */
  const unit = texts.some((text) => TREE_GLYPH.test(text)) ? 3 : 2;

  for (const [index, line] of lines.entries()) {
    const text = texts[index]!;
    if (text.trim() === "") {
      // Runs of blank lines are one gap: a terminal pads with them, a web
      // layout has margins for that.
      if (rows.length > 0 && rows[rows.length - 1]!.kind !== "gap") rows.push({ kind: "gap" });
      continue;
    }

    const consumed = PREFIX.exec(text)?.[1]?.length ?? 0;
    const depth = consumed === 0 ? 0 : Math.max(1, Math.ceil(consumed / unit));

    /*
     * The first line that says anything is the widget's title — that is where a
     * terminal puts it, and where a reader looks.
     */
    const heading = !seenText && depth === 0;
    seenText = true;

    rows.push({ kind: "row", depth, heading, spans: dropTrailing(dropLeading(line, consumed)) });
  }

  while (rows.length > 0 && rows[rows.length - 1]!.kind === "gap") rows.pop();
  return rows;
}
