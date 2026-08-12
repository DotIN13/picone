import {
  query,
  type ModelInfo,
  type Options,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { homedir } from "node:os";
import path from "node:path";
import type {
  AgentCapabilities,
  AgentMode,
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
 * Claude Code behind one Picone session (§58).
 *
 * One `query()` per loaded session, in streaming-input mode, held open for the
 * life of the session rather than one per turn. Streaming input is what makes
 * `interrupt()`, `setModel()`, `getContextUsage()` and the hooks available at
 * all; a fresh query per message would re-pay process start every turn and lose
 * every one of them. The cost is a `claude` child process per loaded session,
 * which is why the app evicts idle ones (§38) and why `dispose` closes it.
 */

const CLAUDE_CAPABILITIES: AgentCapabilities = {
  rewind: true,
  fork: true,
  // `/compact` is a command rather than an API, but it is a real one.
  compact: true,
  // Claude decides for itself; there is no switch to offer.
  autoCompaction: false,
  reload: true,
  exportHtml: false,
  extensionUi: false,
  fileCheckpoints: false,
  /*
   * Planning, and back again (§58).
   *
   * Claude Code cycles three modes; the third, `acceptEdits`, is deliberately
   * absent. It stops the *CLI* asking about file edits, which changes nothing
   * here because Picone's own gate asks anyway — the workspace's
   * `permissions.files` is the setting that means that, and two switches for one
   * decision is how they end up disagreeing.
   */
  modes: ["plan"],
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
  private input = new InputQueue();
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
  /** The name Claude holds for this session (§26), once it has one. */
  private storedName: string | undefined;
  /** Skills as the init frame reports them, and subagents beside them (§34). */
  private skills: ResourceInfo[] = [];
  private subagents: ResourceInfo[] = [];
  /** The model catalogue, which only a live session can be asked for. */
  private models: ModelInfo[] = [];
  private currentModelId: string | undefined;
  private currentEffort: string | undefined;
  /** Resolves when the running turn produces its `result` message. */
  private turnDone: (() => void) | null = null;
  /** A turn the human stopped, whose result is still on its way. */
  private abandoned = false;
  /** How the agent is allowed to act (§58). */
  private currentMode: AgentMode = "default";

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
    const wanted = this.workspace.file.models?.claude;
    this.currentModelId = wanted?.model;
    this.currentEffort = wanted?.thinking;
    await this.startQuery(this.context.resumeRef);
  }

  /**
   * Open a query, resuming a session or starting this one.
   *
   * Called again by a rewind (§53), which is why it is separate from `init`:
   * going back to an earlier point means a new query against a shorter
   * history, and everything else about the session stays as it is.
   */
  private async startQuery(resume: string | undefined): Promise<void> {
    const executable = claudeExecutable();
    if (!executable) {
      throw new Error(
        "No Claude Code executable found. Install Claude Code, or set PICONE_CLAUDE_PATH to where it lives.",
      );
    }

    const { cwd, id } = this.context;
    const dir = cwd;
    const resumeRef = resume;
    this.input = new InputQueue();

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
    void this.pump(this.query);

    /*
     * The id is known before anything runs: it is ours for a new session and
     * the resumed one otherwise, and the CLI confirms it on the init frame.
     * Worth having up front so a session that is closed before it says anything
     * can still be reopened.
     */
    this.sessionId = resumeRef ?? id;

    /*
     * A resumed session may have been renamed elsewhere — in a terminal, or by
     * Claude itself — and the file is the shared artifact (§26), so its name
     * wins over ours.
     */
    if (resume) {
      try {
        const { getSessionInfo } = await import("@anthropic-ai/claude-agent-sdk");
        const info = await getSessionInfo(resume, { dir });
        /*
         * `customTitle` only, not `summary`: the summary is auto-generated from
         * the first prompt, so taking it would rename every Picone session to
         * its own opening line the moment it was reopened. A name is something
         * somebody chose.
         */
        this.storedName = info?.customTitle || undefined;
      } catch {
        // A session store that cannot be read costs a name, not a session.
      }
    }

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
      /*
       * What the session is running, for the picker (§58). `default` is a real
       * entry in the catalogue rather than a placeholder — it is what the CLI
       * itself shows before a model is chosen — and it stays the label until
       * somebody chooses, because the wire id the stream later reports
       * (`claude-sonnet-4-6`) is not one of the rows a human picked from.
       */
      this.currentModelId ??= this.models.some((model) => model.value === "default") ? "default" : undefined;
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

  /** Drain one query's stream for as long as that query is the session's. */
  private async pump(owned: Query): Promise<void> {
    try {
      for await (const message of owned) {
        if (this.query !== owned) return;
        handleClaudeMessage(this.host.translator, message, this.toolNames, {
          sessionId: (id) => (this.sessionId = id),
          commands: (commands) => {
            this.commandList = commands;
            // The `/` menu is cached per session in the browser (§43), so a
            // list that changed under us has to be pushed rather than waited
            // for.
            this.host.emit({ type: "session.commands", sessionId: this.host.sessionId, commands });
          },
          init: (init) => {
            this.currentModelId ??= init.model;
            this.skills = (init.skills ?? []).map((skill) => ({ name: skill, source: "" }));
          },
          result: (result) => {
            this.lastResult = result;
            this.persisted = true;
            this.streaming = false;
            /*
             * The result for a turn somebody stopped arrives *after* the
             * interrupt returns, by which time the next message may already
             * have been sent — so an unclaimed result would resolve the wrong
             * turn and complain about an ending the human asked for.
             */
            if (this.abandoned) {
              this.abandoned = false;
              return;
            }
            if (result.subtype !== "success") {
              const detail = "result" in result && typeof result.result === "string" ? result.result : "";
              this.host.translator.notice(
                detail || `The turn ended early: ${result.subtype.replace(/_/g, " ")}.`,
                detail ? "error" : "warn",
              );
            }
            this.endTurn();
          },
        });

      }
    } catch (error) {
      if (this.disposed || this.query !== owned) return;
      this.host.translator.notice(`Claude stopped: ${(error as Error).message}`, "error");
      this.host.translator.setState("idle");
    } finally {
      if (this.query !== owned) return;
      /*
       * Whatever happened, nobody is still waiting for this turn. A caller
       * blocked on `prompt` when the CLI dies would otherwise wait for a
       * result that is never coming, and the socket handler waits with it.
       */
      this.streaming = false;
      this.endTurn();
    }
  }

  /** Release whoever is waiting for the current turn, at most once. */
  private endTurn(): void {
    const done = this.turnDone;
    this.turnDone = null;
    done?.();
  }

  /**
   * Tag each user message with the entry it became (§53).
   *
   * Read back from the session file rather than taken off the stream, because
   * neither carries it live: the SDK does not echo a prompt back (it only
   * replays them when resuming) and this CLI leaves `user_message_uuid` off
   * the result. What the file does have is every prompt, in order, with the
   * uuid a fork or a rewind needs.
   *
   * Paired from the end like Pi's (§8): the transcript in memory is only the
   * tail (§14), so the two sequences share a suffix rather than a prefix. The
   * check is that the entry starts with what we displayed — the model-facing
   * copy has mentions appended (§52) — and the moment they disagree it stops.
   */
  async syncEntryIds(): Promise<void> {
    if (!this.persisted || !this.sessionId) return;
    const { getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    let prompts: Array<{ uuid: string; text: string }>;
    try {
      const messages = await getSessionMessages(this.sessionId, { dir: this.context.cwd });
      prompts = messages
        .filter((message) => message.type === "user" && isPrompt(message.message))
        .map((message) => ({ uuid: message.uuid, text: promptText(message.message) }));
    } catch {
      // A session file that cannot be read costs a rewind affordance, which is
      // the right way to be wrong.
      return;
    }

    const items = this.host.userMessages();
    for (let offset = 1; offset <= Math.min(prompts.length, items.length); offset++) {
      const entry = prompts[prompts.length - offset];
      const item = items[items.length - offset];
      if (!entry || !item) break;
      if (item.entryId === entry.uuid) continue;
      if (!entry.text.trimStart().startsWith(item.text.trimStart())) break;
      this.host.tagEntry(item.id, entry.uuid);
    }
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
    this.abandoned = this.streaming;
    await this.query.interrupt();
    this.streaming = false;
    this.endTurn();
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

  mode(): AgentMode {
    return this.currentMode;
  }

  /**
   * Put the session into planning, or take it out (§58).
   *
   * The CLI holds the mode, so this is a control request rather than a flag of
   * ours — which also means a mode survives a rewind only because the mode is
   * set again after the query restarts.
   */
  async setMode(mode: AgentMode): Promise<void> {
    await this.query.setPermissionMode(mode === "plan" ? "plan" : "default");
    this.currentMode = mode;
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
   * The models this session could switch to (§58).
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

  /**
   * Go back to just before a message, in this session (§53).
   *
   * Claude has no way to walk a session tree in place, but it can copy one up
   * to a point — so a rewind is a fork you stay in: the history up to that
   * message becomes a new session, and this session's query is reopened
   * against it. The abandoned path stays on disk under the old id, which is
   * the same bargain Pi's rewind makes.
   */
  async rewindTo(entryRef: string): Promise<{ cancelled: boolean; editorText?: string }> {
    if (this.streaming) throw new Error("Stop Claude before rewinding.");
    const { resumeRef } = await this.forkFrom(entryRef);
    if (!resumeRef) return { cancelled: true };

    const previous = this.query;
    this.input.close();
    await this.startQuery(resumeRef);
    try {
      previous.close();
    } catch {
      // A query that has already ended is not a problem worth raising.
    }
    this.sessionId = resumeRef;
    this.persisted = true;
    // The mode belongs to the query, and this is a new one.
    if (this.currentMode !== "default") await this.setMode(this.currentMode);
    // The shell has the message's text and puts it back in the composer.
    return { cancelled: false };
  }

  /**
   * The same point in a session of its own (§53).
   *
   * `forkSession` copies the transcript into a new session id, remapping every
   * uuid and keeping the parent chain — so the fork is resumable exactly like
   * any other session and the original is untouched.
   *
   * `upToMessageId` is *inclusive*, and Picone forks from *before* a message so
   * the new session opens with it in the composer rather than having already
   * asked it (§53). The cut is therefore the entry before ours, which means
   * reading the session's own list to find out what that was — the transcript
   * here only records ids for user messages, and the entry in between is an
   * assistant turn.
   */
  async forkFrom(entryRef: string): Promise<{ resumeRef: string | null }> {
    if (!this.persisted || !this.sessionId) return { resumeRef: null };
    const { forkSession, getSessionMessages } = await import("@anthropic-ai/claude-agent-sdk");
    const messages = await getSessionMessages(this.sessionId, { dir: this.context.cwd });
    const index = messages.findIndex((message) => message.uuid === entryRef);
    // Forking from the very first message is just a new session, which is what
    // a null handle becomes.
    if (index <= 0) return { resumeRef: null };
    const forked = await forkSession(this.sessionId, {
      dir: this.context.cwd,
      upToMessageId: messages[index - 1]!.uuid,
    });
    return { resumeRef: forked.sessionId };
  }

  /**
   * The name Claude has for this session (§26).
   *
   * Read from the session store rather than held here, the same way Pi's is
   * read from its session file: the CLI can be pointed at the same session, and
   * whatever it is called there is what it is called. `undefined` covers both
   * "no name yet" and "no session yet", which want the same answer.
   */
  agentName(): string | undefined {
    return this.storedName;
  }

  /**
   * Rename it on Claude's side too, so the name is not only Picone's.
   *
   * Fire-and-forget: `renameSession` writes to the session file and there is
   * nothing to wait for, while the shell wants the stored name back
   * immediately. A rename that fails leaves Picone's title as the only one,
   * which is what it was before this existed.
   */
  rename(title: string): string {
    this.storedName = title;
    if (this.persisted && this.sessionId) {
      void import("@anthropic-ai/claude-agent-sdk")
        .then((sdk) => sdk.renameSession(this.sessionId!, title, { dir: this.context.cwd }))
        .catch((error) => {
          this.host.translator.notice(`Could not rename the session for Claude: ${(error as Error).message}`, "warn");
        });
    }
    return title;
  }

  /**
   * Claude Code's own directory (§9).
   *
   * `~/.claude` is where the CLI keeps this session's transcript and, in plan
   * mode, the plan it is writing — so a gate that refuses it turns planning
   * into a mode that cannot record a plan. It is the agent's own store, not the
   * user's project, and the agent writes there with or without us.
   */
  agentRoots(): string[] {
    return [path.join(homedir(), ".claude")];
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
    this.endTurn();
    this.input.close();
    try {
      this.query?.close();
    } catch {
      // Closing a query that has already ended is not a problem worth raising.
    }
  }
}

/**
 * Whether a stored `user` entry is something the human said.
 *
 * Tool results are user messages too, as far as the API is concerned, and an
 * entry tagged against one puts §53's handle in the middle of a turn.
 */
function isPrompt(message: unknown): boolean {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return true;
  if (!Array.isArray(content)) return false;
  return !content.some((block) => (block as { type?: string }).type === "tool_result");
}

/** The text of a stored prompt, whichever shape it was written in. */
function promptText(message: unknown): string {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      (block as { type?: string }).type === "text" ? String((block as { text?: string }).text ?? "") : "",
    )
    .join("");
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
 * (§58). The two Claude does not have — `off` and `minimal` — are the low end,
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
