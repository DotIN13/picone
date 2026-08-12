import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Workspace } from "@picone/protocol";
import type { AgentHost } from "../agents/backend.ts";
import { resolvedVoice } from "../workspace/schema.ts";

/**
 * Picone's own tools, for Claude (§23, §29).
 *
 * The same three the Pi backend defines in `pi/tools.ts`, described in the same
 * words — the wording is the part that matters, and it should not drift between
 * agents. They differ only in plumbing: Pi takes tool definitions directly,
 * where the SDK takes an MCP server, so these run in-process and reach the
 * model as `mcp__picone__resolve_comment`.
 */
type SdkTools = NonNullable<Parameters<typeof createSdkMcpServer>[0]["tools"]>;

export function piconeTools(host: AgentHost, workspace: Workspace): McpSdkServerConfigWithInstance {
  const tools: SdkTools = [
    /*
     * Closing a comment is the agent's job, not the reader's (DESIGN §23).
     *
     * It used to mark them "addressed" and leave the last step to a button,
     * which meant a queue of finished work waiting on a click that added
     * nothing: the person who wrote the comment can see whether it was dealt
     * with by looking at the file. So the agent resolves, and the reader reads.
     */
    tool(
      "resolve_comment",
      "Resolve a file comment once you have changed the work in response to it, or established that no change is " +
        "needed — say which in your reply. Resolving is how a comment leaves the list, so do it as you finish each " +
        "one rather than in a batch at the end.",
      { commentId: z.string().describe("The commentId given to you when the comment was delivered.") },
      async ({ commentId }) => {
        const comment = host.resolveComment(commentId);
        if (!comment) throw new Error(`No comment with id ${commentId}`);
        return { content: [{ type: "text" as const, text: `Resolved comment ${commentId}.` }] };
      },
    ),

    tool(
      "list_open_comments",
      "List the file comments the user has left that are still open, with their anchors and ids.",
      {},
      async () => {
        const comments = host.openComments();
        if (comments.length === 0) {
          return { content: [{ type: "text" as const, text: "No open comments." }] };
        }
        const text = comments
          .map((c) => {
            const at = c.lineStart != null ? ` (around line ${c.lineStart})` : "";
            return `- ${c.id}\n  file: ${c.path}${at}\n  selected: ${truncate(c.matcher)}\n  comment: ${c.body}`;
          })
          .join("\n");
        return { content: [{ type: "text" as const, text }] };
      },
    ),
  ];

  if (resolvedVoice(workspace.file).output) {
    tools.push(
      tool(
        "speak",
        "Speak a short message aloud to the user through their browser. Use this when the user benefits from hearing " +
          "something without looking at the screen: you need approval, a long task finished, or you changed direction. " +
          "Do not narrate every response — most output belongs in chat.",
        { text: z.string().describe("The sentence or two to speak aloud. Keep it short and conversational.") },
        async ({ text }) => {
          host.speak(text);
          return { content: [{ type: "text" as const, text: "Spoken to the user." }] };
        },
      ),
    );
  }

  return createSdkMcpServer({ name: "picone", version: "0.1.0", tools });
}

function truncate(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
