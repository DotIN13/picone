import { randomUUID } from "node:crypto";
import type { FileComment, FileCommentInput } from "@picone/protocol";
import { insertComment, listCommentsForWorkspace, setCommentStatus } from "../db.ts";

export function createComment(
  workspaceId: string,
  sessionId: string,
  input: Omit<FileCommentInput, "type" | "commentId">,
): FileComment {
  const comment: FileComment = {
    id: randomUUID(),
    workspaceId,
    sessionId,
    path: input.path,
    matcher: input.matcher,
    lineStart: input.lineStart,
    lineEnd: input.lineEnd,
    body: input.body,
    status: "open",
    createdAt: new Date().toISOString(),
  };
  insertComment(comment);
  return comment;
}

/**
 * The agent has dealt with a comment, so it leaves the list (§23).
 *
 * There was an "addressed" step between this and resolved, waiting on a click
 * from the reader. It bought nothing — whether the work was done is visible in
 * the file — and left finished comments cluttering the list until someone
 * cleared them one at a time. The status remains in the type for comments
 * already saved under it.
 */
export function resolveComment(commentId: string): FileComment | null {
  return setCommentStatus(commentId, "resolved");
}

export function listComments(workspaceId: string): FileComment[] {
  return listCommentsForWorkspace(workspaceId);
}

export { setCommentStatus };
