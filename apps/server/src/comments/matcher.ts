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
      `When you have acted on this feedback, call mark_comment_addressed with commentId "${input.commentId}".`,
  );

  return lines.join("\n");
}

export function commentToInput(comment: FileComment): FileCommentInput {
  return {
    type: "file_comment",
    path: comment.path,
    matcher: comment.matcher,
    lineStart: comment.lineStart,
    lineEnd: comment.lineEnd,
    body: comment.body,
    commentId: comment.id,
  };
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
