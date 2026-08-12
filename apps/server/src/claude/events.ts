import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { EventTranslator } from "../agents/translator.ts";

/**
 * The Claude Agent SDK's message stream, in the terms the transcript is
 * assembled in (DESIGN §30, §58).
 *
 * The SDK says the same things Pi does in a different order and a different
 * shape. Text and thinking arrive as `stream_event` deltas; a tool call arrives
 * as a `tool_use` block on an assistant message and its result as a
 * `tool_result` block on the *user* message that follows, which is the API's
 * shape rather than a conversational one — the human did not say it.
 */

export interface ClaudeStreamHooks {
  /** Remember the SDK id of a user message, so §53 has something to address. */
  userMessage?(uuid: string): void;
  /** The turn ended: cost and usage, for `/stats` (§36). */
  result?(message: Extract<SDKMessage, { type: "result" }>): void;
  /** The session id the CLI assigned or resumed. */
  sessionId?(id: string): void;
  /** What the session came up as: its model, and the skills it can reach. */
  init?(message: Extract<SDKMessage, { type: "system"; subtype: "init" }>): void;
}

/** Tool calls we have seen start, so a result can be matched to its name. */
type ToolNames = Map<string, string>;

export function handleClaudeMessage(
  translator: EventTranslator,
  message: SDKMessage,
  names: ToolNames,
  hooks: ClaudeStreamHooks = {},
): void {
  switch (message.type) {
    case "system":
      handleSystem(translator, message, hooks);
      return;

    case "stream_event": {
      // A subagent's stream is its own conversation; showing it inline would
      // interleave two voices in one transcript (§58).
      if (message.parent_tool_use_id) return;
      const event = message.event as {
        type: string;
        delta?: { type?: string; text?: string; thinking?: string };
      };
      if (event.type !== "content_block_delta" || !event.delta) return;
      if (event.delta.type === "text_delta" && event.delta.text) translator.delta(event.delta.text);
      else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
        translator.thinking(event.delta.thinking);
      }
      return;
    }

    case "assistant": {
      if (message.parent_tool_use_id) return;
      /*
       * The text is already on screen from the deltas, so this pass is only
       * looking for tool calls. `toolStarted` flushes whatever the assistant
       * had been saying, which is what puts the call after the sentence that
       * introduced it rather than before.
       */
      for (const block of message.message.content) {
        if (block.type !== "tool_use") continue;
        names.set(block.id, block.name);
        translator.toolStarted(block.id, block.name, block.input);
      }
      return;
    }

    case "user": {
      if (message.parent_tool_use_id) return;
      const content = message.message.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const id = String(block.tool_use_id);
        translator.toolFinished(id, names.get(id) ?? "tool", {
          isError: Boolean(block.is_error),
          output: resultText(block.content),
          details: toolDetails(message.tool_use_result),
        });
        names.delete(id);
      }
      return;
    }

    case "result": {
      translator.endAssistant();
      translator.setState("idle");
      // Whether an unsuccessful ending is worth saying out loud is the
      // backend's call: it knows whether the human just pressed stop.
      hooks.result?.(message);
      return;
    }

    default:
      return;
  }
}

function handleSystem(
  translator: EventTranslator,
  message: Extract<SDKMessage, { type: "system" }>,
  hooks: ClaudeStreamHooks,
): void {
  switch (message.subtype) {
    case "init":
      hooks.sessionId?.(message.session_id);
      hooks.init?.(message);
      return;

    /*
     * Compaction (§54). Claude does it on its own and says so afterwards, where
     * Pi announces the start and the end; one notice covers both because there
     * is nothing to say in advance.
     */
    case "compact_boundary": {
      const meta = message.compact_metadata;
      const before = meta?.pre_tokens;
      const after = meta?.post_tokens;
      const saved =
        before && after !== undefined
          ? ` — about ${format(before)} of context down to ${format(after)}`
          : before
            ? ` — about ${format(before)} of context summarised`
            : "";
      translator.notice(
        `${meta?.trigger === "manual" ? "Conversation compacted" : "Context was filling, so the conversation was compacted"}${saved}. Earlier turns are summarised from here on.`,
        "info",
      );
      return;
    }

    /*
     * A tool the CLI's own layer refused before it reached ours. It should be
     * rare — the gate answers first — but a silent refusal is the kind of thing
     * that makes an agent look like it ignored an instruction.
     */
    case "permission_denied":
      translator.notice(`Claude was refused permission to use ${message.tool_name}.`, "warn");
      return;

    default:
      return;
  }
}

/** A tool result's content: a string, or the usual blocks. */
function resultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      part && typeof part === "object" && (part as { type?: string }).type === "text"
        ? String((part as { text?: string }).text ?? "")
        : "",
    )
    .filter(Boolean)
    .join("\n");
}

/**
 * How large a `details` payload may be before it is dropped — these are written
 * to the database with the transcript row (§56).
 */
const MAX_DETAILS = 16_000;

/**
 * The structured result behind a tool call (§56).
 *
 * The SDK offers `tool_use_result`, which is the tool's own Output object
 * rather than the text handed to the model — a todo list, a diff, a subagent's
 * report. Passed through untouched for the browser to recognise or ignore, and
 * only when it is an object: a plain string is the text we already have.
 */
function toolDetails(result: unknown): unknown {
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  try {
    const encoded = JSON.stringify(result);
    if (!encoded || encoded.length > MAX_DETAILS) return undefined;
  } catch {
    return undefined;
  }
  return result;
}

function format(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}
