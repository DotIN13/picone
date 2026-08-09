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

export function markAddressed(commentId: string): FileComment | null {
  return setCommentStatus(commentId, "addressed");
}

export function listComments(workspaceId: string): FileComment[] {
  return listCommentsForWorkspace(workspaceId);
}

export { setCommentStatus };
