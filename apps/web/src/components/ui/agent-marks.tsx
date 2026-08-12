import type { ComponentProps } from "solid-js";
import { splitProps } from "solid-js";

/**
 * A mark for each agent (§58), drawn rather than pasted.
 *
 * These sit in a row of Lucide glyphs, so they are built the way Lucide builds
 * one: a 24-unit box, no fill, `currentColor`, round caps and joins, and
 * `absoluteStrokeWidth` handled the way the set handles it — the stroke is
 * given in the icon's own units and scaled back down, which is what keeps a
 * 13px mark the same weight as the 13px glyph beside it. A downloaded brand SVG
 * would carry its own fills and weights and would read as a sticker.
 *
 * They are recognisable rather than official: π for Pi, and the radiating burst
 * for Claude.
 */

interface MarkProps extends Omit<ComponentProps<"svg">, "children"> {
  size?: number;
  strokeWidth?: number;
  absoluteStrokeWidth?: boolean;
}

/** Lucide's own arithmetic: a stroke in icon units, not screen units. */
function frame(props: MarkProps) {
  const [local, rest] = splitProps(props, ["size", "strokeWidth", "absoluteStrokeWidth"]);
  const size = () => local.size ?? 16;
  const stroke = () =>
    local.absoluteStrokeWidth === false
      ? (local.strokeWidth ?? 1.5)
      : ((local.strokeWidth ?? 1.5) * 24) / size();
  return { size, stroke, rest };
}

export function PiMark(props: MarkProps) {
  const { size, stroke, rest } = frame(props);
  return (
    <svg
      {...rest}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={stroke()}
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {/* The bar, then the two legs — the right one curling out, as the letter
          is usually drawn. */}
      <path d="M4.5 7.5h15" />
      <path d="M9.25 7.5c0 4-.25 7.2-1.25 10.5" />
      <path d="M15 7.5v7.75c0 1.6 1 2.6 2.5 2.5" />
    </svg>
  );
}

export function ClaudeMark(props: MarkProps) {
  const { size, stroke, rest } = frame(props);
  return (
    <svg
      {...rest}
      width={size()}
      height={size()}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      stroke-width={stroke()}
      stroke-linecap="round"
      stroke-linejoin="round"
    >
      {/* A burst: four long rays on the axes, four short ones between them.
          Even rays would be an asterisk, which is what the app's own sparkle
          already looks like at 13px — the unequal lengths are what make this
          read as a different thing. Drawn as strokes through the centre so the
          middle stays one join rather than a blot. */}
      <path d="M12 3.5v17" />
      <path d="M3.5 12h17" />
      <path d="M7.4 7.4l9.2 9.2" />
      <path d="M16.6 7.4l-9.2 9.2" />
    </svg>
  );
}
