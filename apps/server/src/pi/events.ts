import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { EventTranslator } from "../agents/translator.ts";
import { formatTokens } from "../agents/translator.ts";

/**
 * Pi's event stream, in the terms the transcript is assembled in (DESIGN §30).
 *
 * Only the reading of Pi's shapes lives here. What a transcript *is* — when a
 * reply is flushed, what gets committed, how a tool call is titled — belongs to
 * `agents/translator.ts` and is shared with every other agent.
 */
export function handlePiEvent(translator: EventTranslator, event: AgentSessionEvent): void {
  switch (event.type) {
    case "session_info_changed":
      translator.renamed(event.name);
      break;

    case "agent_start":
      translator.setState("thinking");
      break;

    case "message_start": {
      const message = event.message as { role?: string };
      if (message.role !== "assistant") break;
      translator.startAssistant();
      break;
    }

    case "message_update": {
      const inner = event.assistantMessageEvent;
      if (inner.type === "text_delta") translator.delta(inner.delta);
      else if (inner.type === "thinking_delta") translator.thinking(inner.delta);
      break;
    }

    case "message_end": {
      const message = event.message as {
        role?: string;
        stopReason?: string;
        errorMessage?: string;
        customType?: string;
        content?: unknown;
        display?: boolean;
      };

      // Extensions report results with `pi.sendMessage({ display: true })`,
      // which arrives as a message with role "custom". The TUI draws these
      // through a registered renderer; here they get their own transcript row.
      if (message.role === "custom") {
        if (message.display !== true) break;
        const text = flattenContent(message.content);
        if (!text.trim()) break;
        translator.endAssistant();
        translator.extensionMessage(message.customType ?? "extension", text);
        break;
      }

      if (message.role !== "assistant") break;
      translator.endAssistant();
      if (message.stopReason === "error" && message.errorMessage) {
        translator.notice(message.errorMessage, "error");
      }
      break;
    }

    case "tool_execution_start":
      translator.toolStarted(event.toolCallId, event.toolName, event.args);
      break;

    case "tool_execution_update":
      translator.toolProgress(event.toolCallId, extractText(event.partialResult));
      break;

    case "tool_execution_end":
      translator.toolFinished(event.toolCallId, event.toolName, {
        isError: event.isError,
        output: extractText(event.result),
        patch: extractPatch(event.result),
        details: extractDetails(event.result),
      });
      break;

    case "agent_end":
      translator.endAssistant();
      translator.setState("idle");
      break;

    case "compaction_start":
      translator.notice(
        event.reason === "overflow"
          ? "Context is full — compacting the conversation so it can continue…"
          : event.reason === "threshold"
            ? "Context is nearly full — compacting the conversation…"
            : "Compacting the conversation…",
        "info",
      );
      break;

    /*
     * Compaction has to say how it ended, not only that it began.
     *
     * Only the start was handled before, so a compaction that failed or was
     * cancelled left "Compacting…" as the last word on the subject — and one
     * that succeeded never said what it had done. Compaction discards history,
     * so it is exactly the operation that should account for itself.
     */
    case "compaction_end": {
      if (event.aborted) {
        translator.notice("Compaction cancelled; the conversation is unchanged.", "info");
        break;
      }
      if (event.errorMessage) {
        translator.notice(
          event.willRetry
            ? `Compaction failed, retrying: ${event.errorMessage}`
            : `Compaction failed: ${event.errorMessage}`,
          event.willRetry ? "warn" : "error",
        );
        break;
      }

      const result = event.result;
      const before = result?.tokensBefore;
      const after = result?.estimatedTokensAfter;
      const saved =
        before && after !== undefined
          ? ` — about ${formatTokens(before)} of context down to ${formatTokens(after)}`
          : "";
      translator.notice(`Conversation compacted${saved}. Earlier turns are summarised from here on.`, "info");
      break;
    }

    case "auto_retry_start":
      translator.notice(
        `Retrying after error (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`,
        "warn",
      );
      break;

    default:
      break;
  }
}

/** Custom message content is either a plain string or content blocks. */
function flattenContent(content: unknown): string {
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

function extractText(result: unknown): string {
  if (!result || typeof result !== "object") return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (part && typeof part === "object" && (part as { type?: string }).type === "text") {
        return String((part as { text?: string }).text ?? "");
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * How large a `details` payload may be before it is dropped.
 *
 * Generous for a description of what a tool did, and small next to a
 * transcript: these are written to the database with the row, so a tool that
 * returns a whole file in `details` would otherwise be stored twice — once as
 * text and once as structure.
 */
const MAX_DETAILS = 16_000;

/**
 * The structured result a tool attached to its output (DESIGN §56).
 *
 * `patch` is pulled out separately and stays there — it has its own renderer.
 * Everything else is passed through untouched, because the point is that we do
 * not know what an extension will put here: the todo tool sends its task list,
 * another might send a table. Judging the shape is the browser's job, and only
 * for the shapes it recognises.
 */
export function extractDetails(result: unknown): unknown {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;

  // `patch` alone is already rendered as a diff; passing it on would draw it
  // twice.
  const keys = Object.keys(details as Record<string, unknown>);
  if (keys.length === 0 || (keys.length === 1 && keys[0] === "patch")) return undefined;

  try {
    const encoded = JSON.stringify(details);
    if (!encoded || encoded.length > MAX_DETAILS) return undefined;
  } catch {
    // Circular, or otherwise not serialisable — it could not survive the trip.
    return undefined;
  }
  return details;
}

function extractPatch(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const patch = (details as { patch?: unknown }).patch;
  return typeof patch === "string" ? patch : undefined;
}
