import { For, Show, splitProps, type ComponentProps, type JSX } from "solid-js";
import type { AgentKind } from "@picone/protocol";

/**
 * A mark for each agent (§58): the real one when still, and one of ours when
 * that agent is working.
 *
 * The still marks are the published symbols — Anthropic's Claude burst (CC0,
 * Wikimedia Commons) and the Pi glyph from pi.dev — because a product's own
 * mark is the thing people recognise and an approximation of one looks like a
 * mistake. The moving marks are drawn here in
 * each agent's idiom: Pi's logo as a character-cell grid that builds in reading
 * order, Claude's asterisk growing through the frames its own CLI cycles.
 *
 * ### Sizes
 *
 * The four drawings have nothing in common: Claude's burst fills its 100 box
 * edge to edge, Pi's glyph occupies 59% of its 800 box, the tile grid is 23 of
 * 24 units and a text glyph is whatever the font says. Left alone they would be
 * four different sizes, and a mark would jump the moment a session started
 * working.
 *
 * So none of them is used as it comes. Each declares its own ink box and is
 * scaled into one 24-unit frame at a fixed size — and the two agents get
 * *different* sizes on purpose, because a chunky block glyph reads heavier than
 * a spiky star at identical measurements. Optical, not arithmetic.
 */

/** How much of the 24-unit frame each mark's ink is allowed to fill. */
const INK = { claude: 18, pi: 15.5 } as const;

export interface AgentMarkProps extends Omit<ComponentProps<"svg">, "children"> {
  agent?: AgentKind;
  size?: number;
  /** Animate: this agent is working (§30's `agent.state`). */
  busy?: boolean;
}

/**
 * One frame for every mark: a 24-unit box with the drawing scaled into the
 * middle of it from whatever box it was drawn in.
 */
function Mark(
  props: {
    agent: AgentKind;
    size: number;
    busy?: boolean;
    /** The ink bounds of the children, in their own units. */
    ink: { x: number; y: number; w: number; h: number };
    children: JSX.Element;
  } & Omit<ComponentProps<"svg">, "children">,
) {
  const [local, rest] = splitProps(props, ["agent", "size", "busy", "ink", "children"]);
  // The longer side is what fills the frame, so a wide mark and a square one
  // sit on the same optical size rather than the same width.
  const scale = () => INK[local.agent] / Math.max(local.ink.w, local.ink.h);
  const left = () => (24 - local.ink.w * scale()) / 2;
  const top = () => (24 - local.ink.h * scale()) / 2;
  return (
    <svg
      {...rest}
      width={local.size}
      height={local.size}
      viewBox="0 0 24 24"
      fill="currentColor"
      data-component="agent-mark"
      data-agent={local.agent}
      data-busy={local.busy ? "" : undefined}
      aria-hidden="true"
    >
      <g transform={`translate(${left()} ${top()}) scale(${scale()}) translate(${-local.ink.x} ${-local.ink.y})`}>
        {local.children}
      </g>
    </svg>
  );
}

/**
 * The Claude symbol: CC0, from Wikimedia Commons (`File:Claude_AI_symbol.svg`),
 * with its fill dropped so it takes the colour of the text beside it.
 *
 * The burst rather than the blockier Claude Code lockup — it is the shape the
 * working frames grow into, so a session that starts working changes only from
 * still to moving rather than from one drawing to another. Its ink fills the
 * 100 box exactly.
 */
const CLAUDE_PATH =
  "m19.6 66.5 19.7-11 .3-1-.3-.5h-1l-3.3-.2-11.2-.3L14 53l-9.5-.5-2.4-.5L0 49l.2-1.5 2-1.3 2.9.2 6.3.5 9.5.6 6.9.4L38 49.1h1.6l.2-.7-.5-.4-.4-.4L29 41l-10.6-7-5.6-4.1-3-2-1.5-2-.6-4.2 2.7-3 3.7.3.9.2 3.7 2.9 8 6.1L37 36l1.5 1.2.6-.4.1-.3-.7-1.1L33 25l-6-10.4-2.7-4.3-.7-2.6c-.3-1-.4-2-.4-3l3-4.2L28 0l4.2.6L33.8 2l2.6 6 4.1 9.3L47 29.9l2 3.8 1 3.4.3 1h.7v-.5l.5-7.2 1-8.7 1-11.2.3-3.2 1.6-3.8 3-2L61 2.6l2 2.9-.3 1.8-1.1 7.7L59 27.1l-1.5 8.2h.9l1-1.1 4.1-5.4 6.9-8.6 3-3.5L77 13l2.3-1.8h4.3l3.1 4.7-1.4 4.9-4.4 5.6-3.7 4.7-5.3 7.1-3.2 5.7.3.4h.7l12-2.6 6.4-1.1 7.6-1.3 3.5 1.6.4 1.6-1.4 3.4-8.2 2-9.6 2-14.3 3.3-.2.1.2.3 6.4.6 2.8.2h6.8l12.6.9 3.3 2.2 2 2.6-.3 2-5.1 2.6-6.8-1.6-16-3.8-5.4-1.4h-.8v.5l4.5 4.4 8.3 7.5 10.4 9.6.5 2.4-1.3 1.9-1.4-.2-9.2-7-3.6-3.1-8-6.7h-.5v.7l1.8 2.7L74 80.5l.8 4.6-.7 1.5-2.6.9-2.8-.5-5.8-8.2-6-9.1-4.8-8.3-.6.3-2.8 30.5-1.3 1.6-3 1.1-2.5-1.9-1.3-3 1.3-6.1 1.6-8 1.3-6.3 1.2-7.9.7-2.6v-.2H49L43 72l-9 12.3-7.2 7.6-1.7.7-3-1.5.3-2.8L24 86l10-12.8 6-7.9 4-4.6-.1-.5h-.3L17.2 77.4l-4.7.6-2-2 .2-3 1-1 8-5.5Z";
const CLAUDE_INK = { x: 0, y: 0, w: 100, h: 100 };

/**
 * The Pi glyph, from `pi.dev/logo.svg`: a blocky P with its dot. Drawn in an
 * 800 box with 165 units of air on every side, which is why it declares its
 * ink rather than its viewBox.
 */
const PI_P =
  "M165.29 165.29 H517.36 V400 H400 V517.36 H282.65 V634.72 H165.29 Z M282.65 282.65 V400 H400 V282.65 Z";
const PI_DOT = "M517.36 400 H634.72 V634.72 H517.36 Z";
const PI_INK = { x: 165.29, y: 165.29, w: 469.43, h: 469.43 };

/**
 * The working grid: Pi's logo reduced to 4×4 character cells, which build in
 * reading order and fall away again — what a terminal does while it draws.
 */
const TILES: Array<[number, number]> = [
  [0, 0], [6, 0], [12, 0],
  [0, 6], [12, 6],
  [0, 12], [6, 12], [18, 12],
  [0, 18], [18, 18],
];
/** Ten tiles of 5 with 1 between them: 23 units square. */
const TILE_INK = { x: 0, y: 0, w: 23, h: 23 };

/** The frames Claude's asterisk grows through, and the one it rests on. */
const FRAMES = ["·", "✢", "✳", "✶", "✻", "✽"];
/**
 * The box the glyph frames are scaled from.
 *
 * Not the em box: a font's ink is smaller than the size it is set at, and at 20
 * the moving mark measured 67% of the frame against the still mark's 75%. This
 * is the number that makes the two the same — found by measuring, because
 * nothing about a font can be derived from here.
 */
const GLYPH_INK = { x: 0, y: 0, w: 17.9, h: 17.9 };

export function AgentMark(props: AgentMarkProps) {
  const [local, rest] = splitProps(props, ["agent", "size", "busy"]);
  const size = () => local.size ?? 16;
  const claude = () => local.agent === "claude";

  return (
    <Show
      when={local.busy}
      fallback={
        <Show
          when={claude()}
          fallback={
            <Mark {...rest} agent="pi" size={size()} ink={PI_INK}>
              <path fill-rule="evenodd" d={PI_P} />
              <path d={PI_DOT} />
            </Mark>
          }
        >
          <Mark {...rest} agent="claude" size={size()} ink={CLAUDE_INK}>
            <path d={CLAUDE_PATH} />
          </Mark>
        </Show>
      }
    >
      <Show
        when={claude()}
        fallback={
          <Mark {...rest} agent="pi" size={size()} busy ink={TILE_INK}>
            <For each={TILES}>
              {([x, y], index) => (
                <rect class="pi-tile" x={x} y={y} width={5} height={5} style={{ "animation-delay": `${index() * 55}ms` }} />
              )}
            </For>
          </Mark>
        }
      >
        <Mark {...rest} agent="claude" size={size()} busy ink={GLYPH_INK}>
          <For each={FRAMES}>
            {(frame, index) => (
              <text
                class="claude-glyph claude-frame"
                x={GLYPH_INK.w / 2}
                y={GLYPH_INK.h / 2}
                style={{ "animation-delay": `${index() * 120}ms` }}
              >
                {frame}
              </text>
            )}
          </For>
        </Mark>
      </Show>
    </Show>
  );
}

/** The still marks, for the icon registry (`<Icon name="agent-pi" />`). */
export function PiMark(props: ComponentProps<"svg"> & { size?: number; strokeWidth?: number }) {
  const [, rest] = splitProps(props, ["strokeWidth", "size"]);
  return <AgentMark {...rest} agent="pi" size={props.size ?? 16} />;
}

export function ClaudeMark(props: ComponentProps<"svg"> & { size?: number; strokeWidth?: number }) {
  const [, rest] = splitProps(props, ["strokeWidth", "size"]);
  return <AgentMark {...rest} agent="claude" size={props.size ?? 16} />;
}
