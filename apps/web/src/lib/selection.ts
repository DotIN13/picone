/**
 * Map a text selection back to line numbers in the file source.
 *
 * Used by the rendered-markdown view, where the DOM has no line information.
 * The matcher text is the primary anchor (DESIGN §17) — lines are a hint, so an
 * approximate match is fine and a miss is acceptable.
 */
export function findLineRange(source: string, selected: string): { lineStart: number; lineEnd: number } | null {
  const needle = normalize(selected);
  if (needle.length < 3) return null;

  const lines = source.split("\n");
  const normalizedLines = lines.map(normalize);

  // Fast path: the whole selection sits inside one line.
  for (let i = 0; i < normalizedLines.length; i++) {
    if (normalizedLines[i] && normalizedLines[i]!.includes(needle)) {
      return { lineStart: i + 1, lineEnd: i + 1 };
    }
  }

  // Otherwise walk forward joining lines until the running text contains it.
  for (let start = 0; start < lines.length; start++) {
    if (!normalizedLines[start]) continue;
    let joined = "";
    for (let end = start; end < Math.min(lines.length, start + 200); end++) {
      joined = joined ? `${joined} ${normalizedLines[end]}` : normalizedLines[end]!;
      if (joined.length > needle.length + 200) break;
      if (joined.includes(needle)) return { lineStart: start + 1, lineEnd: end + 1 };
    }
  }

  // Last resort: anchor on the first distinctive chunk of the selection.
  const head = needle.slice(0, 40);
  const index = normalizedLines.findIndex((line) => line.includes(head));
  return index === -1 ? null : { lineStart: index + 1, lineEnd: index + 1 };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}
