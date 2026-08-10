/**
 * Whether a fenced code block has been closed.
 *
 * marked emits a `code` token the moment the *opening* fence arrives and grows
 * its text as the block streams, so anything that interprets the contents —
 * a Mermaid diagram, say — would be handed a syntactically incomplete document
 * on every chunk and would flash errors all the way to the closing fence.
 * Images do not have this problem: marked produces an `image` token only once
 * the whole construct is there.
 *
 * Reading `raw` rather than counting characters, because the closing fence may
 * be indented and may or may not have a trailing newline.
 */
export function fenceClosed(raw: string): boolean {
  const end = raw.trimEnd();
  return end.endsWith("```") || end.endsWith("~~~");
}
