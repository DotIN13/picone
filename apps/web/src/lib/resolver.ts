import { createSignal } from "solid-js";
import type { ResolvedPath } from "@picone/protocol";
import { api } from "./api.ts";

/**
 * The client half of path resolution (DESIGN §51).
 *
 * A transcript asks the same question over and over — every re-render of every
 * message re-encounters the same paths — so the answers are cached for the life
 * of the page and the questions are batched into one request per tick.
 *
 * The cache is reactive: a reference renders as plain text immediately, and
 * upgrades itself when the answer lands. Nothing waits on the network to draw.
 */

const cache = new Map<string, ResolvedPath>();
const [version, bump] = createSignal(0);
const invalidate = () => bump((v) => v + 1);

/** Asked for but not yet answered — the dedupe that keeps a batch honest. */
const inFlight = new Set<string>();
let queued = new Set<string>();
let scheduled = false;

/**
 * A resolution is only as good as the tree it was made against, so opening a
 * different workspace throws it away. Misses are the reason this matters: a
 * path that did not exist under the old roots may well exist under the new.
 */
export function clearResolutions(): void {
  cache.clear();
  inFlight.clear();
  queued = new Set();
  invalidate();
}

async function flush(): Promise<void> {
  scheduled = false;
  const batch = [...queued];
  queued = new Set();
  if (batch.length === 0) return;

  for (const path of batch) inFlight.add(path);
  try {
    const { results } = await api.resolvePaths(batch);
    for (const result of results) cache.set(result.path, result);
  } catch {
    // A failed lookup is not an error the user needs: the reference stays
    // plain text, which is exactly what it was a moment ago. Record the miss
    // so a broken server does not mean retrying on every render.
    for (const path of batch) cache.set(path, { path, exists: false });
  } finally {
    for (const path of batch) inFlight.delete(path);
    invalidate();
  }
}

/**
 * The answer for a path, or `undefined` while it is unknown. Asking queues the
 * lookup as a side effect, which is what makes this usable directly from a
 * component body: read it, and it arranges to become true.
 */
export function resolution(path: string): ResolvedPath | undefined {
  // Subscribe first, so a component re-runs when the batch lands even if the
  // path is not in the cache yet.
  version();

  const hit = cache.get(path);
  if (hit) return hit;

  if (!inFlight.has(path) && !queued.has(path)) {
    queued.add(path);
    if (!scheduled) {
      scheduled = true;
      // A microtask would split a streaming message into a batch per token;
      // a short timer collects a whole render pass into one request.
      setTimeout(() => void flush(), 16);
    }
  }
  return undefined;
}
