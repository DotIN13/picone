import { For, Show, splitProps, type ComponentProps, type JSX } from "solid-js";
import type { AgentKind } from "@picone/protocol";

/**
 * A mark for each agent (§58): the real one when still, and one of ours when
 * that agent is working.
 *
 * The still marks are the products' own: Claude Code's mark and the Pi glyph
 * from pi.dev, because a product's mark is the thing people recognise and an
 * approximation of one looks like a mistake. The moving marks are drawn here in
 * each agent's idiom: Pi's logo as a character-cell grid that builds in reading
 * order, Claude's asterisk growing through the frames its own CLI cycles.
 *
 * ### Sizes
 *
 * The four drawings have nothing in common: Claude Code's mark is 24 wide and
 * 15 tall, Pi's glyph occupies 59% of its 800 box, the tile grid is 23 of 24
 * units and a text glyph is whatever the font says. Left alone they would be
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
 * Claude Code's mark: the burst rendered in character cells, which is the
 * product this backend actually drives — Claude Code, not the chat. Its fill
 * is dropped so it takes the colour of the text beside it.
 *
 * Wide rather than square: 24 across and 15 tall, which is why the frame
 * measures both sides.
 */
const CLAUDE_CODE_PATH =
  "M20.998 10.949H24v3.102h-3v3.028h-1.487V20H18v-2.921h-1.487V20H15v-2.921H9V20H7.488v-2.921H6V20H4.487v-2.921H3V14.05H0V10.95h3V5h17.998v5.949zM6 10.949h1.488V8.102H6v2.847zm10.51 0H18V8.102h-1.49v2.847z";
const CLAUDE_CODE_INK = { x: 0, y: 5, w: 24, h: 15 };

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
          <Mark {...rest} agent="claude" size={size()} ink={CLAUDE_CODE_INK}>
            <path clip-rule="evenodd" fill-rule="evenodd" d={CLAUDE_CODE_PATH} />
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
