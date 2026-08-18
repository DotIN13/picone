import type { FileComment, FileCommentInput } from "@picone/protocol";

/**
 * Turn a structured comment into the model-facing text (DESIGN §19).
 * There is no separate comment subsystem for the agent — this just enters the
 * normal message flow.
 */
export function formatCommentForModel(input: FileCommentInput): string {
  const lines: string[] = [];
  lines.push("The user left a comment on:");
  lines.push("");
  lines.push(input.path);

  if (input.lineStart != null) {
    const range = input.lineEnd != null && input.lineEnd !== input.lineStart
      ? `lines ${input.lineStart}-${input.lineEnd}`
      : `line ${input.lineStart}`;
    lines.push("");
    lines.push(`Around ${range}.`);
  }

  lines.push("");
  lines.push("Selected text:");
  lines.push("");
  lines.push(quote(input.matcher));
  lines.push("");
  lines.push("Comment:");
  lines.push("");
  lines.push(quote(input.body));
  lines.push("");
  lines.push(
    `If the exact selected text has moved or changed, search the file for it. ` +
      `When you have dealt with this, call resolve_comment with commentId "${input.commentId}".`,
  );

  return lines.join("\n");
}

export function commentToInput(comment: FileComment): FileCommentInput {
  return {
    path: comment.path,
    matcher: comment.matcher,
    lineStart: comment.lineStart,
    lineEnd: comment.lineEnd,
    body: comment.body,
    commentId: comment.id,
  };
}

/**
 * What a message carrying comments looks like, in both readings (DESIGN §19).
 *
 * A comment is parked as a pill in the composer and sent when the reader
 * decides to send it (§18), so it arrives beside whatever they typed rather
 * than as a message of its own. Both readings are composed here, from the
 * stored row: the browser sends ids, and never has to hold a second copy of the
 * wording. A message with no words at all reads exactly as a lone comment used
 * to, which is the case this grew out of.
 */
export function withCommentBlocks(text: string, comments: FileComment[]): string {
  const parts = [text.trim(), ...comments.map((comment) => formatCommentForModel(commentToInput(comment)))];
  return parts.filter((part) => part !== "").join("\n\n---\n\n");
}

export function withCommentSummaries(display: string, comments: FileComment[]): string {
  return [display.trim(), ...comments.map(commentSummary)].filter((part) => part !== "").join("\n\n");
}

/**
 * What the chat transcript shows for a comment. The model gets the full
 * structured block; the human already knows what they selected.
 */
export function commentSummary(comment: FileComment): string {
  const file = comment.path.split(/[\\/]/).pop() ?? comment.path;
  const at = comment.lineStart != null ? `:${comment.lineStart}` : "";
  const selected = comment.matcher.replace(/\s+/g, " ").trim();
  const quoted = selected.length > 160 ? `${selected.slice(0, 159)}…` : selected;
  return `${file}${at}\n“${quoted}”\n\n${comment.body}`;
}

function quote(text: string): string {
  return `"""\n${text}\n"""`;
}

/**
 * The open comments on any file a message names (DESIGN §16, §51).
 *
 * Naming a file in a message is how you hand it to the agent, and the comments
 * already left on it are part of what you are handing over — otherwise the
 * agent reads a file it has been given and works from a version of it nobody
 * has annotated, while the notes sit in a list it would have to think to ask
 * for. Matched on the absolute path, in either slash, because that is what
 * dropping a file or completing an `@` puts in the message.
 *
 * Resolved comments are left out: they were dealt with, and repeating them
 * every time the file comes up would grow without limit. So are the ones the
 * message is already carrying as pills (§18) — the agent is about to read those
 * in full, a few lines further up.
 */
export function commentContext(text: string, comments: FileComment[]): string | null {
  const posix = (value: string) => value.toLowerCase().split("\\").join("/");
  const haystack = posix(text);
  const named = comments.filter(
    (comment) => comment.status !== "resolved" && haystack.includes(posix(comment.path)),
  );
  if (named.length === 0) return null;

  const byFile = new Map<string, FileComment[]>();
  for (const comment of named) {
    const list = byFile.get(comment.path) ?? [];
    list.push(comment);
    byFile.set(comment.path, list);
  }

  const lines: string[] = ["Open comments on the files named above:"];
  for (const [path, list] of byFile) {
    lines.push("");
    lines.push(`${path}`);
    for (const comment of list) {
      const at = comment.lineStart != null ? ` (line ${comment.lineStart})` : "";
      const selected = comment.matcher.replace(/\s+/g, " ").trim();
      const quoted = selected.length > 160 ? `${selected.slice(0, 159)}…` : selected;
      lines.push(`- ${at ? `${at.trim()} ` : ""}“${quoted}” — ${comment.body} [commentId ${comment.id}]`);
    }
  }
  lines.push("");
  lines.push("Resolve each with resolve_comment once you have dealt with it.");
  return lines.join("\n");
}
