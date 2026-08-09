import type { ModelOption, ThinkingLevel } from "@picone/protocol";

/** Pi's thinking levels, lowest effort first. */
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** The subset of a Pi model we need on the wire. */
interface PiModel {
  provider: string;
  id: string;
  name?: string;
  reasoning?: boolean;
  /** Maps Pi levels to provider values; `null` marks a level unsupported. */
  thinkingLevelMap?: Partial<Record<string, string | null>>;
}

/**
 * Work out which thinking levels a model actually accepts.
 *
 * Models vary far more than a fixed list suggests: `gemini-2.0-flash` has no
 * thinking at all, `gemini-3.5-flash` cannot be turned off, `o3` offers only
 * low/medium/high, and `deepseek-v4-pro` only high/max. Pi encodes this in
 * `thinkingLevelMap`, where an explicit `null` means unsupported and a missing
 * key means "use the provider default", which is supported.
 */
export function thinkingLevelsFor(model: PiModel): ThinkingLevel[] {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap;
  if (!map) return [...THINKING_LEVELS];
  return THINKING_LEVELS.filter((level) => map[level] !== null);
}

export function describeModel(model: PiModel): ModelOption {
  return {
    provider: model.provider,
    id: model.id,
    name: model.name ?? model.id,
    reasoning: Boolean(model.reasoning),
    thinkingLevels: thinkingLevelsFor(model),
  };
}

/**
 * Pick the closest level a model supports, so switching models keeps the user's
 * intent instead of silently resetting. Falls back to the nearest neighbour by
 * effort, which is what "clamping" should mean.
 */
export function nearestThinkingLevel(
  wanted: ThinkingLevel | undefined,
  supported: ThinkingLevel[],
): ThinkingLevel | undefined {
  if (supported.length === 0) return undefined;
  if (wanted && supported.includes(wanted)) return wanted;

  const target = wanted ? THINKING_LEVELS.indexOf(wanted) : THINKING_LEVELS.indexOf("medium");
  let best = supported[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const level of supported) {
    const distance = Math.abs(THINKING_LEVELS.indexOf(level) - target);
    if (distance < bestDistance) {
      best = level;
      bestDistance = distance;
    }
  }
  return best;
}
