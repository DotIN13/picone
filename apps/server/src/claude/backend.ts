import {
  query,
  type ModelInfo,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentCapabilities,
  ContextUsage,
  ResourceInfo,
  ResourceReport,
  ModelOption,
  SessionModel,
  SlashCommand,
  ThinkingLevel,
  Workspace,
} from "@picone/protocol";
import type { AgentBackend, AgentBackendContext, AgentHost } from "../agents/backend.ts";
import { memoryContextFiles } from "../memory/context.ts";
import { workspaceContext } from "../workspace/loader.ts";
import { claudeExecutable } from "./available.ts";
import { handleClaudeMessage } from "./events.ts";
import { piconeTools } from "./tools.ts";

/**
 * Claude Code behind one Picone session (§57).
 *
 * One `query()` per loaded session, in streaming-input mode, held open for the
 * life of the session rather than one per turn. Streaming input is what makes
 * `interrupt()`, `setModel()`, `getContextUsage()` and the hooks available at
 * all; a fresh query per message would re-pay process start every turn and lose
 * every one of them. The cost is a `claude` child process per loaded session,
 * which is why the app evicts idle ones (§38) and why `dispose` closes it.
 */

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  // Claude's `resume` + `resumeSessionAt` rebuilds by restarting the query
  // rather than navigating a tree in place, which is a different operation with
  // a different cost. Not wired yet; see docs/todo/claude-agent.md.
  rewind: false,
  fork: false,
  // `/compact` is a command rather than an API, but it is a real one.
  compact: true,
  // Claude decides for itself; there is no switch to offer.
  autoCompaction: false,
  reload: true,
  exportHtml: false,
  extensionUi: false,
  fileCheckpoints: false,
};

/** Anthropic is the only provider behind this backend. */
const PROVIDER = "anthropic";

/**
 * A queue the input generator drains, so a turn is a push rather than a new
 * query. Nothing clever: the SDK wants an async iterable and we want to hand it
 * messages as the human writes them.
 */
class InputQueue {
  private readonly waiting: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;

  push(message: SDKUserMessage): void {
    this.waiting.push(message);
    this.wake?.();
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      const next = this.waiting.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => (this.wake = resolve));
      this.wake = null;
    }
  }
}

export class ClaudeBackend implements AgentBackend {
  readonly kind = "claude" as const;
  readonly capabilities = CLAUDE_CAPABILITIES;

  private query!: Query;
  private readonly input = new InputQueue();
  private workspace: Workspace;
  private streaming = false;
  private disposed = false;
  /** Tool names by call id, so a result can be matched to what started it. */
  private readonly toolNames = new Map<string, string>();
  /**
   * Calls the gate has already allowed, by `toolUseID`.
   *
   * The hook and `canUseTool` are two views of the same decision (see below),
   * and the human must only be asked once.
   */
  private readonly allowed = new Set<string>();
  private lastResult: Extract<SDKMessage, { type: "result" }> | null = null;
  private sessionId: string | undefined;
  /**
   * Whether the CLI has actually written this session down.
   *
   * The id is known before anything happens, but resuming one the CLI never
   * wrote fails the turn that tries — quietly, as `error_during_execution` with
   * an empty result. So the id is only offered as a resume handle once a turn
   * has completed under it.
   */
  private persisted = false;
  private commandList: SlashCommand[] = [];
  /** Skills as the init frame reports them, and subagents beside them (§34). */
  private skills: ResourceInfo[] = [];
  private subagents: ResourceInfo[] = [];
  /** The model catalogue, which only a live session can be asked for. */
  private models: ModelInfo[] = [];
  private currentModelId: string | undefined;
  private currentEffort: string | undefined;
  /** Resolves when the running turn produces its `result` message. */
  private turnDone: (() => void) | null = null;

  private constructor(private readonly context: AgentBackendContext) {
    this.workspace = context.workspace;
  }

  static async create(context: AgentBackendContext): Promise<ClaudeBackend> {
    const backend = new ClaudeBackend(context);
    await backend.init();
    return backend;
  }

  private get host(): AgentHost {
    return this.context.host;
  }

  private async init(): Promise<void> {
    const executable = claudeExecutable();
    if (!executable) {
      throw new Error(
        "No Claude Code executable found. Install Claude Code, or set PICONE_CLAUDE_PATH to where it lives.",
      );
    }

    const { cwd, id, resumeRef } = this.context;
    const wanted = this.workspace.file.models?.claude;
    this.currentModelId = wanted?.model;
    this.currentEffort = wanted?.thinking;

    const options: Options = {
      cwd,
      pathToClaudeCodeExecutable: executable,
      /*
       * Picone's own session id is a UUID, and the SDK will take one — so the
       * two sides share an id and there is no mapping table to keep. Resuming
       * passes the same id back; `sessionId` and `resume` are mutually
       * exclusive, which is why this is a choice rather than both.
       */
      ...(resumeRef ? { resume: resumeRef } : { sessionId: id }),
      includePartialMessages: true,
      /*
       * The user's own Claude Code world — `~/.claude` skills, subagents and
       * CLAUDE.md, plus the project's `.claude` — is the analogue of Pi
       * discovering the user's global skills, and leaving it out would make
       * Picone a poorer place to run Claude than a terminal.
       */
      settingSources: ["user", "project"],
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        // The same text §6 and §50 give Pi: what this workspace is, and what
        // each memory directory says about itself.
        append: this.workspaceBriefing(),
      },
      // Everything the workspace opens, hidden roots included (§3): the file
      // tree may leave a directory out, but the agent can still reach it.
      additionalDirectories: this.workspace.roots
        .filter((root) => root.exists && root.kind !== "cwd")
        .map((root) => root.path),
      mcpServers: {
        ...this.mcpServers(),
        // Picone's own tools (§23, §29), in-process rather than a subprocess.
        picone: piconeTools(this.host, this.workspace),
      },
      ...(this.currentModelId ? { model: this.currentModelId } : {}),
      ...(effortLevel(this.currentEffort) ? { effort: effortLevel(this.currentEffort) } : {}),

      /*
       * The gate (§9/§10), across the two surfaces the spike established.
       *
       * The hook is the decision: it is the only thing that sees *every* call,
       * including the reads the CLI approves without asking anybody. It can
       * refuse, and a refusal is final. What it cannot do is grant — a Write it
       * allows still comes back `permission_denied`, because the CLI's own
       * layer has nobody to prompt in a headless session. So `canUseTool`
       * carries the decision out for the calls that would have been prompted,
       * looking up what the hook already decided rather than asking twice.
       */
      hooks: {
        PreToolUse: [
          {
            hooks: [
              async (input, toolUseId) => {
                if (input.hook_event_name !== "PreToolUse") return {};
                const decision = await this.host.askPermission(input.tool_name, input.tool_input);
                if (decision.allowed) {
                  if (toolUseId) this.allowed.add(toolUseId);
                  return {};
                }
                return {
                  hookSpecificOutput: {
                    hookEventName: "PreToolUse" as const,
                    permissionDecision: "deny" as const,
                    permissionDecisionReason: decision.reason ?? "Refused in Picone.",
                  },
                };
              },
            ],
          },
        ],
      },
      canUseTool: async (toolName, input, extra) => {
        if (extra.toolUseID && this.allowed.delete(extra.toolUseID)) {
          return { behavior: "allow", updatedInput: input };
        }
        // Not seen by the hook: ask the gate rather than assume either way.
        const decision = await this.host.askPermission(toolName, input);
        return decision.allowed
          ? { behavior: "allow", updatedInput: input }
          : { behavior: "deny", message: decision.reason ?? "Refused in Picone." };
      },
    };

    this.query = query({ prompt: this.input.stream(), options });
    void this.pump();

    /*
     * The id is known before anything runs: it is ours for a new session and
     * the resumed one otherwise, and the CLI confirms it on the init frame.
     * Worth having up front so a session that is closed before it says anything
     * can still be reopened.
     */
    this.sessionId = resumeRef ?? id;

    // What this session can do — commands, models, subagents — comes back from
    // the initialize control request rather than from a turn.
    try {
      const init = await this.query.initializationResult();
      this.commandList = (init.commands ?? []).map((command) => ({
        name: command.name,
        description: command.description,
        source: "builtin" as const,
      }));
      this.models = init.models ?? [];
      this.subagents = (init.agents ?? []).map((agent) => ({
        name: agent.name,
        description: agent.description,
        source: "",
      }));
    } catch (error) {
      this.host.translator.notice(`Claude started but did not report itself: ${(error as Error).message}`, "warn");
    }
  }

  /** The workspace description and the memory stores, as one appended block. */
  private workspaceBriefing(): string {
    const parts = [workspaceContext(this.workspace)];
    for (const file of memoryContextFiles(this.workspace.memory)) {
      parts.push(`## ${file.path}\n\n${file.content}`);
    }
    return parts.join("\n\n---\n\n");
  }

  /**
   * The workspace's MCP servers, in the SDK's shape.
   *
   * Claude spawns its own connections rather than sharing Picone's, so a server
   * used by both agents is running twice. Wasteful, and for a stateful server
   * possibly worse than wasteful; sharing would need a schema bridge between
   * two tool systems, which is a bigger piece of work than this.
   */
  private mcpServers(): Record<string, { type: "stdio" | "http"; [key: string]: unknown }> {
    const out: Record<string, { type: "stdio" | "http"; [key: string]: unknown }> = {};
    for (const [name, config] of Object.entries(this.context.services.mcpConfigs())) {
      if (config.enabled === false) continue;
      if (config.url) out[name] = { type: "http", url: config.url, headers: config.headers };
      else if (config.command) {
        out[name] = { type: "stdio", command: config.command, args: config.args ?? [], env: config.env };
      }
    }
    return out;
  }

  /** Drain the SDK's stream for as long as the session is open. */
  private async pump(): Promise<void> {
    try {
      for await (const message of this.query) {
        handleClaudeMessage(this.host.translator, message, this.toolNames, {
          sessionId: (id) => (this.sessionId = id),
          init: (init) => {
            this.currentModelId = init.model ?? this.currentModelId;
            this.skills = (init.skills ?? []).map((skill) => ({ name: skill, source: "" }));
          },
          result: (result) => {
            this.lastResult = result;
            this.persisted = true;
            this.streaming = false;
            this.turnDone?.();
            this.turnDone = null;
          },
        });
        if (message.type === "user" && !message.parent_tool_use_id && message.uuid) {
          // Claude says outright which entry a message became, where Pi has to
          // be inferred from (§53).
          this.noteUserEntry(message.uuid);
        }
      }
    } catch (error) {
      if (this.disposed) return;
      this.streaming = false;
      this.turnDone?.();
      this.turnDone = null;
      this.host.translator.notice(`Claude stopped: ${(error as Error).message}`, "error");
      this.host.translator.setState("idle");
    }
  }

  /**
   * The uuid of the message the human just sent, against the last untagged user
   * item in the transcript. The SDK replays *its* copy of the prompt, which is
   * the model-facing text — so the newest untagged one is the match, in the
   * same order they were sent.
   */
  private noteUserEntry(uuid: string): void {
    const items = this.host.userMessages();
    const untagged = items.filter((item) => !item.entryId);
    const item = untagged[untagged.length - 1];
    if (item) this.host.tagEntry(item.id, uuid);
  }

  // --- the conversation ---------------------------------------------------------

  async prompt(text: string): Promise<void> {
    this.streaming = true;
    this.host.translator.setState("thinking");
    this.input.push(userMessage(text));
    // Resolves when the turn's `result` arrives, so the shell's "after the
    // turn" work — context usage, entry ids — happens after the turn.
    await new Promise<void>((resolve) => (this.turnDone = resolve));
  }

  /**
   * Steering is the same push. The CLI queues a message that arrives mid-turn
   * and folds it into the run, which is what Pi's `steer` does by another
   * route; `priority: "now"` is the SDK's way of saying "not after the queue".
   */
  async steer(text: string): Promise<void> {
    this.input.push({ ...userMessage(text), priority: "now" });
  }

  async abort(): Promise<void> {
    await this.query.interrupt();
    this.streaming = false;
    this.turnDone?.();
    this.turnDone = null;
  }

  get isStreaming(): boolean {
    return this.streaming;
  }

  // --- the model -----------------------------------------------------------------

  model(): SessionModel | undefined {
    if (!this.currentModelId) return undefined;
    return { provider: PROVIDER, model: this.currentModelId, thinking: this.currentEffort };
  }

  async setModel(_provider: string, model: string, thinking?: string): Promise<void> {
    await this.query.setModel(model);
    this.currentModelId = model;
    const effort = effortLevel(thinking);
    if (effort) {
      await this.query.applyFlagSettings({ effortLevel: effort });
      this.currentEffort = thinking;
    }
  }

  /** The CLI's own reading, which is the same one `/context` shows (§54). */
  async contextUsage(): Promise<ContextUsage | null> {
    const usage = await this.query.getContextUsage();
    if (!usage) return null;
    return {
      tokens: usage.totalTokens,
      contextWindow: usage.maxTokens,
      percent: usage.percentage,
    };
  }

  commands(): SlashCommand[] {
    return this.commandList;
  }

  /**
   * Claude discovers skills and subagents rather than extensions and prompt
   * templates, so two of the three columns are empty. Better empty than filled
   * with something that is not what the heading says.
   */
  resources(): ResourceReport | null {
    return { extensions: this.subagents, skills: this.skills, prompts: [] };
  }

  /**
   * The models this session could switch to (§57).
   *
   * Claude's effort levels and Picone's thinking levels are nearly the same
   * list, so a model's supported efforts go straight into `thinkingLevels` and
   * the picker needs no new concept. A model with none simply offers none,
   * which is what per-model levels were built for.
   */
  modelOptions(): ModelOption[] {
    return this.models.map((model) => ({
      provider: PROVIDER,
      id: model.value,
      name: model.displayName,
      reasoning: Boolean(model.supportsEffort || model.supportsAdaptiveThinking),
      thinkingLevels: (model.supportedEffortLevels ?? []) as ThinkingLevel[],
    }));
  }

  async statsLines(): Promise<string[]> {
    const result = this.lastResult;
    if (!result) return ["Nothing has been asked yet, so there is nothing to count."];
    const usage = result.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    const cached = usage?.cache_read_input_tokens ?? 0;
    return [
      `${result.num_turns} turns · ${Math.round(result.duration_ms / 100) / 10}s of wall clock`,
      `Tokens: ${(input + output).toLocaleString()} (${input.toLocaleString()} in, ${output.toLocaleString()} out, ${cached.toLocaleString()} cached)`,
      `Cost: $${result.total_cost_usd.toFixed(4)} — the SDK's estimate, not a bill`,
    ];
  }

  // --- session-level operations ----------------------------------------------------

  /** Claude has no compaction API; `/compact` is a command like any other. */
  async compact(): Promise<void> {
    await this.prompt("/compact");
  }

  /** Skills are what Claude can be told to re-read (§34). */
  async reload(): Promise<void> {
    const refreshed = await this.query.reloadSkills();
    const commands = (refreshed as { commands?: Array<{ name: string; description: string }> }).commands;
    if (commands) {
      this.commandList = commands.map((command) => ({
        name: command.name,
        description: command.description,
        source: "skill" as const,
      }));
    }
  }

  updateWorkspace(workspace: Workspace): void {
    this.workspace = workspace;
  }

  /**
   * The session id, once there is a session to resume — see `persisted`. A
   * session that was opened and closed without a word is not one.
   */
  resumeRef(): string | undefined {
    return this.persisted ? this.sessionId : this.context.resumeRef;
  }

  dispose(): void {
    this.disposed = true;
    this.input.close();
    try {
      this.query?.close();
    } catch {
      // Closing a query that has already ended is not a problem worth raising.
    }
  }
}

function userMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    session_id: "",
    parent_tool_use_id: null,
    message: { role: "user", content: text },
  };
}

/**
 * Picone's thinking levels and Claude's effort levels are nearly the same list
 * (§57). The two Claude does not have — `off` and `minimal` — are the low end,
 * so they clamp to `low` rather than being dropped.
 */
function effortLevel(thinking: string | undefined): "low" | "medium" | "high" | "xhigh" | "max" | undefined {
  switch (thinking) {
    case "off":
    case "minimal":
    case "low":
      return "low";
    case "medium":
      return "medium";
    case "high":
      return "high";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return undefined;
  }
}
