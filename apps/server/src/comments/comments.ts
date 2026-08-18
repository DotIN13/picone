import { randomUUID } from "node:crypto";
import type { FileComment, FileCommentInput } from "@picone/protocol";
import { insertComment, listCommentsForWorkspace, setCommentStatus } from "../db.ts";

export function createComment(
  workspaceId: string,
  sessionId: string,
  input: Omit<FileCommentInput, "commentId">,
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
 * A comment is finished, so it leaves the list (§22).
 *
 * Either side may say so: the agent when it has dealt with the feedback, the
 * reader when the note no longer needs anyone. One status, because "done" does
 * not mean two different things depending on who noticed.
 *
 * There was an "addressed" step between open and resolved, waiting on a click
 * from the reader. It bought nothing — whether the work was done is visible in
 * the file — and left finished comments cluttering the list until someone cleared
 * them one at a time. Rows saved under it are migrated on open (`db.ts`), so the
 * status is gone from the type as well as from the interface.
 */
export function resolveComment(commentId: string): FileComment | null {
  return setCommentStatus(commentId, "resolved");
}

export function listComments(workspaceId: string): FileComment[] {
  return listCommentsForWorkspace(workspaceId);
}

export { setCommentStatus };
