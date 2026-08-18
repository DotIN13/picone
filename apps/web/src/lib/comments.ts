import type { FileComment } from "@picone/protocol";

/**
 * Where a comment is, short enough to read inside a sentence (§18, §21).
 *
 * The filename and the line, which is how anyone refers to a place in a file
 * out loud. Not the path: a pill sits in a composer a hundred characters wide,
 * and the full path is in the comment itself for anything that needs it.
 */
export function commentLabel(comment: FileComment): string {
  const file = comment.path.split(/[\\/]/).pop() ?? comment.path;
  return comment.lineStart != null ? `${file}:${comment.lineStart}` : file;
}
