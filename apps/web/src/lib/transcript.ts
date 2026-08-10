import type { ChatItem } from "@picone/protocol";

/**
 * Add an item to a transcript, or fold an update into the one already there.
 *
 * The update is *merged into* the existing object rather than replacing it, and
 * that is the whole point of this function existing. `<For>` in the transcript
 * keys on reference: a replacement is a different reference, so the row would
 * be torn down and rebuilt, taking any state inside it along. A tool call
 * updates many times while it runs — its expanded output closed itself on every
 * one of them.
 *
 * Only changed fields are written, so an update that touches one field does not
 * invalidate anything bound to the others. A change of `kind` is the one case
 * that cannot be merged: the shapes differ, and stale keys from the old shape
 * would survive the assignment.
 *
 * Mutates in place, so it must be called inside `produce`.
 */
export function upsertItem(items: ChatItem[], item: ChatItem): void {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index === -1) {
    items.push(item);
    return;
  }

  const existing = items[index]!;
  if (existing.kind !== item.kind) {
    items[index] = item;
    return;
  }

  const target = existing as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(item)) {
    if (target[key] !== value) target[key] = value;
  }
}
