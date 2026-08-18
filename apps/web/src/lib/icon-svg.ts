/**
 * Icons for the two corners of the interface Solid does not draw (§57).
 *
 * The composer field builds its own DOM so a mention can be one atomic node,
 * and a CodeMirror widget builds its own so a comment card can sit between two
 * lines. Neither can use the `Icon` component, and a character is not the
 * alternative: an emoji renders as whatever glyph the platform has, lands in
 * `textContent` where it is not text, and cannot take the hairline. So the same
 * lucide outlines are assembled here — once, in one place — and sized and
 * weighted in CSS, which is where the zoom correction can still be read.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Lucide paths, matching the entries of the same name in `ui/icon.tsx`. */
const PATHS = {
  comment:
    "M22 17a2 2 0 0 1-2 2H6.828a2 2 0 0 0-1.414.586l-2.202 2.202A.71.71 0 0 1 2 21.286V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z",
  check: "M20 6 9 17l-5-5",
} as const;

export type DrawnIcon = keyof typeof PATHS;

/**
 * One icon, as the DOM holds it.
 *
 * `size` is in design pixels, like the component's, and travels as a custom
 * property rather than as width and height: the stroke has to be divided by it
 * as well, and one number the stylesheet can do arithmetic with beats three
 * attributes that cannot.
 */
export function iconElement(name: DrawnIcon, size: number): SVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");
  svg.dataset.slot = "icon-svg";
  svg.dataset.drawn = "";
  svg.style.setProperty("--icon-size", String(size));

  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", PATHS[name]);
  svg.appendChild(path);
  return svg;
}
