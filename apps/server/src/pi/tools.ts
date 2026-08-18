import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { FileComment } from "@picone/protocol";

export interface PiconeToolHooks {
  /** Voice output as an explicit agent tool (DESIGN §29). */
  speak(text: string): void;
  /** The agent closing a comment it has dealt with (DESIGN §23). */
  resolveComment(commentId: string): FileComment | null;
  /** Comments the agent may still need to act on. */
  openComments(): FileComment[];
}

export function createSpeakTool(hooks: PiconeToolHooks): ToolDefinition {
  return defineTool({
    name: "speak",
    label: "Speak",
    description:
      "Speak a short message aloud to the user through their browser. Use this when the user benefits from hearing " +
      "something without looking at the screen: you need approval, a long task finished, or you changed direction. " +
      "Do not narrate every response — most output belongs in chat.",
    parameters: Type.Object({
      text: Type.String({ description: "The sentence or two to speak aloud. Keep it short and conversational." }),
    }),
    execute: async (_toolCallId, params) => {
      hooks.speak(params.text);
      return { content: [{ type: "text", text: "Spoken to the user." }], details: { text: params.text } };
    },
  });
}

export function createCommentTools(hooks: PiconeToolHooks): ToolDefinition[] {
  /*
   * Closing a comment the agent has dealt with is the agent's job (DESIGN §23).
   *
   * It used to mark them "addressed" and leave the last step to a button, which
   * meant a queue of finished work waiting on a click that added nothing: the
   * person who wrote the comment can see whether it was dealt with by looking
   * at the file. So the agent closes what it has done — without waiting to be
   * told — and the reader closes what no longer needs anyone (§22), which is a
   * different thing and not a confirmation of this one.
   */
  const resolveComment = defineTool({
    name: "resolve_comment",
    label: "Resolve comment",
    description:
      "Resolve a file comment once you have changed the work in response to it, or established that no change is " +
      "needed — say which in your reply. Resolving is how a comment leaves the list, so do it as you finish each " +
      "one rather than in a batch at the end.",
    parameters: Type.Object({
      commentId: Type.String({ description: "The commentId given to you when the comment was delivered." }),
    }),
    execute: async (_toolCallId, params) => {
      const comment = hooks.resolveComment(params.commentId);
      if (!comment) {
        throw new Error(`No comment with id ${params.commentId}`);
      }
      return {
        content: [{ type: "text", text: `Resolved comment ${params.commentId}.` }],
        details: { comment },
      };
    },
  });

  const listOpen = defineTool({
    name: "list_open_comments",
    label: "List open comments",
    description: "List the file comments the user has left that are still open, with their anchors and ids.",
    parameters: Type.Object({}),
    execute: async () => {
      const comments = hooks.openComments();
      if (comments.length === 0) {
        return { content: [{ type: "text", text: "No open comments." }], details: { comments } };
      }
      const text = comments
        .map((c) => {
          const at = c.lineStart != null ? ` (around line ${c.lineStart})` : "";
          return `- ${c.id}\n  file: ${c.path}${at}\n  selected: ${truncate(c.matcher)}\n  comment: ${c.body}`;
        })
        .join("\n");
      return { content: [{ type: "text", text }], details: { comments } };
    },
  });

  return [resolveComment, listOpen];
}

function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
