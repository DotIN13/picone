import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentState, ChatItem, ToolCall } from "@picone/protocol";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface TranslatorHooks {
  emit(event: AgentEvent): void;
  /** Called when a transcript item reaches its final form and can be persisted. */
  commit(item: ChatItem): void;
  /** Pi's session name changed — from `/name`, an extension, or from us. */
  renamed?(name: string | undefined): void;
}

/**
 * Translates Pi's event stream into the browser protocol (DESIGN §30).
 * Pi's internal event shapes never reach the UI.
 */
export class EventTranslator {
  private assistantId: string | null = null;
  private assistantText = "";
  private assistantThinking = "";
  private readonly toolCalls = new Map<string, ToolCall>();
  private state: AgentState = "idle";

  constructor(private readonly hooks: TranslatorHooks) {}

  getState(): AgentState {
    return this.state;
  }

  setState(state: AgentState): void {
    if (this.state === state) return;
    this.state = state;
    this.hooks.emit({ type: "agent.state", state });
  }

  handle(event: AgentSessionEvent): void {
    switch (event.type) {
      case "session_info_changed":
        this.hooks.renamed?.(event.name);
        break;

      case "agent_start":
        this.setState("thinking");
        break;

      case "message_start": {
        const message = event.message as { role?: string };
        if (message.role !== "assistant") break;
        this.startAssistant();
        break;
      }

      case "message_update": {
        const inner = event.assistantMessageEvent;
        if (!this.assistantId) this.startAssistant();
        if (inner.type === "text_delta") {
          this.assistantText += inner.delta;
          this.setState("streaming");
          this.hooks.emit({ type: "assistant.delta", id: this.assistantId!, text: inner.delta });
        } else if (inner.type === "thinking_delta") {
          this.assistantThinking += inner.delta;
          this.setState("thinking");
          this.hooks.emit({ type: "assistant.thinking", id: this.assistantId!, text: inner.delta });
        }
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
          this.endAssistant();
          this.emitExtensionMessage(message.customType ?? "extension", text);
          break;
        }

        if (message.role !== "assistant") break;
        this.endAssistant();
        if (message.stopReason === "error" && message.errorMessage) {
          this.notice(message.errorMessage, "error");
        }
        break;
      }

      case "tool_execution_start": {
        // The assistant text before a tool call is final; flush it so the
        // transcript reads in the order things actually happened.
        this.endAssistant();
        const toolCall: ToolCall = {
          id: event.toolCallId,
          name: event.toolName,
          title: summarizeArgs(event.toolName, event.args),
          args: event.args,
          status: "running",
        };
        this.toolCalls.set(event.toolCallId, toolCall);
        this.setState("tool");
        this.hooks.emit({ type: "tool.started", toolCall });
        break;
      }

      case "tool_execution_update": {
        const toolCall = this.toolCalls.get(event.toolCallId);
        if (!toolCall) break;
        const output = extractText(event.partialResult);
        if (output) toolCall.output = output;
        this.hooks.emit({ type: "tool.updated", toolCall: { ...toolCall } });
        break;
      }

      case "tool_execution_end": {
        const toolCall = this.toolCalls.get(event.toolCallId) ?? {
          id: event.toolCallId,
          name: event.toolName,
          title: event.toolName,
          args: {},
          status: "running" as const,
        };
        toolCall.status = event.isError ? "error" : "ok";
        toolCall.output = extractText(event.result) || toolCall.output;
        const patch = extractPatch(event.result);
        if (patch) toolCall.patch = patch;
        this.toolCalls.delete(event.toolCallId);
        this.hooks.emit({ type: "tool.completed", toolCall: { ...toolCall } });
        this.hooks.commit({ kind: "tool", id: toolCall.id, toolCall: { ...toolCall }, at: now() });
        this.setState("thinking");
        break;
      }

      case "agent_end":
        this.endAssistant();
        this.setState("idle");
        break;


      case "compaction_start":
        this.notice(
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
       * that succeeded never said what it had done. Compaction discards
       * history, so it is exactly the operation that should account for itself.
       */
      case "compaction_end": {
        if (event.aborted) {
          this.notice("Compaction cancelled; the conversation is unchanged.", "info");
          break;
        }
        if (event.errorMessage) {
          this.notice(
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
        this.notice(`Conversation compacted${saved}. Earlier turns are summarised from here on.`, "info");
        break;
      }

      case "auto_retry_start":
        this.notice(`Retrying after error (attempt ${event.attempt}/${event.maxAttempts}): ${event.errorMessage}`, "warn");
        break;

      default:
        break;
    }
  }

  private emitExtensionMessage(customType: string, text: string): void {
    const id = randomUUID();
    const at = now();
    this.hooks.emit({ type: "extension.message", id, customType, text, at });
    this.hooks.commit({ kind: "extension", id, customType, text, at });
  }

  notice(text: string, level: "info" | "warn" | "error"): void {
    this.hooks.emit({ type: "notice", text, level });
    this.hooks.commit({ kind: "notice", id: randomUUID(), text, level, at: now() });
  }

  /** Flush any partial assistant message, e.g. when a run is aborted. */
  flush(): void {
    this.endAssistant();
  }

  private startAssistant(): void {
    if (this.assistantId) return;
    this.assistantId = randomUUID();
    this.assistantText = "";
    this.assistantThinking = "";
    this.hooks.emit({ type: "assistant.start", id: this.assistantId });
  }

  private endAssistant(): void {
    if (!this.assistantId) return;
    const id = this.assistantId;
    const text = this.assistantText;
    const thinking = this.assistantThinking;
    this.assistantId = null;
    this.assistantText = "";
    this.assistantThinking = "";

    this.hooks.emit({ type: "assistant.end", id, text });
    if (text.trim() || thinking.trim()) {
      this.hooks.commit({ kind: "assistant", id, text, thinking: thinking || undefined, at: now() });
    }
  }
}

function now(): string {
  return new Date().toISOString();
}

/** One-line description of a tool call for the chat transcript. */
export function summarizeArgs(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
    case "ls":
      return typeof a.path === "string" ? a.path : toolName;
    case "grep":
      return `${String(a.pattern ?? "")}${a.path ? ` in ${String(a.path)}` : ""}`;
    case "find":
      return String(a.pattern ?? a.path ?? toolName);
    default: {
      const preview = JSON.stringify(a);
      return preview.length > 120 ? `${preview.slice(0, 117)}…` : preview;
    }
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

function extractPatch(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const details = (result as { details?: unknown }).details;
  if (!details || typeof details !== "object") return undefined;
  const patch = (details as { patch?: unknown }).patch;
  return typeof patch === "string" ? patch : undefined;
}

/** Token counts read at a glance rather than counted digit by digit. */
function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}
