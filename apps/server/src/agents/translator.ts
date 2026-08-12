import { randomUUID } from "node:crypto";
import type { AgentEvent, AgentState, ChatItem, ToolCall } from "@picone/protocol";

/**
 * Assembles the browser protocol (DESIGN §30) out of whatever an agent is
 * doing, for any agent.
 *
 * The awkward part of a transcript is not the events, it is their order. A
 * reply arrives as deltas that have to be collected into one message; a tool
 * call in the middle of that reply has to appear *after* the text that
 * preceded it and before the text that follows; a message with nothing in it
 * must not be committed at all. Those rules took a while to get right and are
 * worth having once rather than once per backend.
 *
 * So this holds the rules and nothing else. What an agent's own event stream
 * looks like is its adapter's problem: `pi/events.ts` reads Pi's, and
 * `claude/events.ts` reads the SDK's, and both call the same methods here.
 */

export interface TranslatorHooks {
  emit(event: AgentEvent): void;
  /** Called when a transcript item reaches its final form and can be persisted. */
  commit(item: ChatItem): void;
  /** The agent's own name for the session changed, from its side (§26). */
  renamed?(name: string | undefined): void;
}

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

  // --- the assistant's own words ---------------------------------------------

  startAssistant(): void {
    if (this.assistantId) return;
    this.assistantId = randomUUID();
    this.assistantText = "";
    this.assistantThinking = "";
    this.hooks.emit({ type: "assistant.start", id: this.assistantId });
  }

  delta(text: string): void {
    if (!this.assistantId) this.startAssistant();
    this.assistantText += text;
    this.setState("streaming");
    this.hooks.emit({ type: "assistant.delta", id: this.assistantId!, text });
  }

  thinking(text: string): void {
    if (!this.assistantId) this.startAssistant();
    this.assistantThinking += text;
    this.setState("thinking");
    this.hooks.emit({ type: "assistant.thinking", id: this.assistantId!, text });
  }

  /**
   * The reply is finished, or has to be flushed because something else is about
   * to happen. Committed only if it said something: an assistant turn that was
   * nothing but a tool call has no row of its own.
   */
  endAssistant(): void {
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

  /** Flush a partial reply — an abort, or a run that ended without saying so. */
  flush(): void {
    this.endAssistant();
  }

  // --- tools -----------------------------------------------------------------

  toolStarted(id: string, name: string, args: unknown): void {
    // Whatever the assistant said before the call is final: flush it so the
    // transcript reads in the order things actually happened.
    this.endAssistant();
    const toolCall: ToolCall = {
      id,
      name,
      title: summarizeArgs(name, args),
      args,
      status: "running",
    };
    this.toolCalls.set(id, toolCall);
    this.setState("tool");
    this.hooks.emit({ type: "tool.started", toolCall });
  }

  /** Output while the tool is still running. Ignored for a call we never saw. */
  toolProgress(id: string, output: string): void {
    const toolCall = this.toolCalls.get(id);
    if (!toolCall) return;
    if (output) toolCall.output = output;
    this.hooks.emit({ type: "tool.updated", toolCall: { ...toolCall } });
  }

  /**
   * A tool call has finished. `name` is needed because a result can arrive for
   * a call we never saw start — a backend that only reports completions, or a
   * restarted stream.
   */
  toolFinished(
    id: string,
    name: string,
    result: { isError?: boolean; output?: string; patch?: string; details?: unknown },
  ): void {
    const toolCall = this.toolCalls.get(id) ?? {
      id,
      name,
      title: name,
      args: {},
      status: "running" as const,
    };
    toolCall.status = result.isError ? "error" : "ok";
    toolCall.output = result.output || toolCall.output;
    if (result.patch) toolCall.patch = result.patch;
    if (result.details !== undefined) toolCall.details = result.details;
    this.toolCalls.delete(id);
    this.hooks.emit({ type: "tool.completed", toolCall: { ...toolCall } });
    this.hooks.commit({ kind: "tool", id: toolCall.id, toolCall: { ...toolCall }, at: now() });
    this.setState("thinking");
  }

  /**
   * How long a running call has been going. For an agent that reports liveness
   * rather than output, which is what the running row has to say instead.
   */
  toolElapsed(id: string, seconds: number): void {
    const toolCall = this.toolCalls.get(id);
    if (!toolCall) return;
    toolCall.elapsed = seconds;
    this.hooks.emit({ type: "tool.updated", toolCall: { ...toolCall } });
  }

  /** Whether a call with this id is still open — for a backend that must ask. */
  isToolRunning(id: string): boolean {
    return this.toolCalls.has(id);
  }

  // --- everything else --------------------------------------------------------

  /**
   * Output an agent pushed outside the conversation — Pi's
   * `sendMessage({ display: true })`, and anything equivalent.
   */
  extensionMessage(customType: string, text: string): void {
    const id = randomUUID();
    const at = now();
    this.hooks.emit({ type: "extension.message", id, customType, text, at });
    this.hooks.commit({ kind: "extension", id, customType, text, at });
  }

  notice(text: string, level: "info" | "warn" | "error"): void {
    this.hooks.emit({ type: "notice", text, level });
    this.hooks.commit({ kind: "notice", id: randomUUID(), text, level, at: now() });
  }

  renamed(name: string | undefined): void {
    this.hooks.renamed?.(name);
  }
}

function now(): string {
  return new Date().toISOString();
}

/**
 * One-line description of a tool call for the chat transcript.
 *
 * Names are matched in lower case because the same tool is `read` in Pi and
 * `Read` in Claude, and what it does is the same either way.
 */
export function summarizeArgs(toolName: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  if (typeof a.command === "string") return a.command;

  const filePath =
    (typeof a.path === "string" && a.path) ||
    (typeof a.file_path === "string" && a.file_path) ||
    (typeof a.filePath === "string" && a.filePath) ||
    (typeof a.notebook_path === "string" && a.notebook_path) ||
    "";

  switch (toolName.toLowerCase()) {
    case "read":
    case "write":
    case "edit":
    case "multiedit":
    case "notebookedit":
    case "ls":
      return filePath || toolName;
    case "grep":
      return `${String(a.pattern ?? "")}${a.path ? ` in ${String(a.path)}` : ""}`;
    case "glob":
    case "find":
      return String(a.pattern ?? a.path ?? toolName);
    default:
      return summarizeUnknown(a);
  }
}

/**
 * A one-line summary of arguments for a tool we know nothing about.
 *
 * Extensions bring their own tools, and dumping their arguments as JSON put
 * `{"action":"update","id":4,"status":"completed"}` in the transcript — mostly
 * punctuation. The values are what carry meaning, so the leading ones are shown
 * bare and the rest are named, which reads as `update · id 4 · completed`.
 *
 * Only scalars: an argument whose value is an object is not summarisable in a
 * line, and guessing at one reads worse than leaving it out.
 */
function summarizeUnknown(args: Record<string, unknown>): string {
  // Keys whose *value* already says what it is: "completed" needs no label,
  // where "4" does.
  const LEAD = new Set(["action", "mode", "name", "subject", "query", "task", "title", "status"]);
  const parts: string[] = [];

  for (const [key, value] of Object.entries(args)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value === "object") continue;
    const text = String(value);
    parts.push(LEAD.has(key) || typeof value === "boolean" ? text : `${key} ${text}`);
    if (parts.length === 4) break;
  }

  if (parts.length === 0) {
    const preview = JSON.stringify(args) ?? "";
    return preview.length > 120 ? `${preview.slice(0, 117)}…` : preview;
  }

  const line = parts.join(" · ");
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** Token counts read at a glance rather than counted digit by digit. */
export function formatTokens(tokens: number): string {
  if (tokens < 1000) return `${tokens}`;
  return `${(tokens / 1000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
}
