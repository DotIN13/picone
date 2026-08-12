# Picone runs one agent, and it is Pi

Everything from the workspace file down assumes a single `AgentSession`
(§8, §41). Adding Claude is worth doing for two reasons that have nothing to do
with preferring one model: the app's own surfaces — comments (§16), the
permission gate (§9), mentions (§52), the file tree, voice — are agent-neutral
ideas that currently only one agent can benefit from, and having two backends is
the only honest test of whether the Pi adapter is as thin as §8 claims.

The seam is the deliverable. If Claude never lands, extracting it still leaves
the codebase better than it found it.

---

## What was verified, and what is still guessed

Written against `@anthropic-ai/claude-agent-sdk@0.3.228` (CLI 2.1.228), read
from its `sdk.d.ts` and exercised with three throwaway probes on this machine.
Everything marked **verified** was observed running; everything else is read
from the types and should be treated as a claim, not a fact.

**Verified.** A `query()` in streaming-input mode authenticates with the Claude
subscription already on this machine — `apiKeySource: "none"`, no API key, first
token in 3.6 s. `includePartialMessages` yields `stream_event` frames whose
`content_block_delta` carries `text_delta` and `thinking_delta`, which is
exactly the shape §30's `assistant.delta` / `assistant.thinking` already expect.
A tool call arrives as an assistant `tool_use` block and its result as a user
`tool_result` block with `is_error`. `getContextUsage()` returned
`{totalTokens: 22295, maxTokens: 200000, percentage: 11}` — §54's dial, with no
arithmetic of ours. `supportedModels()` returned five rows with per-model effort
levels; `supportedCommands()` returned 44.

**Verified, and it changes the design.** `canUseTool` is *not* a gate. It was
never called for a `Read` — the CLI approves reads itself — and the SDK warns
that any bare name in `allowedTools` shadows the callback entirely. A
`PreToolUse` hook *is* a gate: it fired for `Read` and for `Bash`, carrying
`tool_name`, `tool_input` and `tool_use_id`, and returning
`permissionDecision: "deny"` put our own sentence in front of the model as the
tool result. So Picone's gate hangs off the hook, and `canUseTool` is at most a
backstop.

**Not verified.** Whether a write or a shell call needs a permissive
`canUseTool` beside the hook or is denied by the CLI's own prompt path in the
absence of a TTY; whether a hook that blocks for a minute waiting for a human
survives; whether `sessionId` + `resume` round-trips across a server restart.
Those three are Phase 0.

---

## The seam

`SessionRuntime` is 937 lines and about half of it has nothing to do with Pi:
the transcript and its database rows, the permission plumbing, `withMentions`,
comment injection, the title, `commit`/`snapshot`/`seedTranscript`. The other
half is `AgentSession`, `SessionManager`, `DefaultResourceLoader`,
`ExtensionUiBridge` and the session tree.

Split along that line, and nothing else:

```
sessions/session.ts     Session          the shell: transcript, db, permissions,
                                         mentions, comments, title, snapshot
agents/backend.ts       AgentBackend     the port
agents/host.ts          AgentHost        what a backend may call back into
agents/pi/…             PiBackend        today's runtime, minus the shell
agents/claude/…         ClaudeBackend    new
```

```ts
export interface AgentBackend {
  readonly kind: AgentKind;
  readonly capabilities: AgentCapabilities;

  prompt(text: string): Promise<void>;
  steer(text: string): Promise<void>;
  abort(): Promise<void>;
  readonly isStreaming: boolean;

  model(): SessionModel | undefined;
  setModel(provider: string, model: string, thinking?: string): Promise<void>;
  contextUsage(): Promise<ContextUsage | null>;
  commands(): SlashCommand[];
  resources(): ResourceReport | null;
  stats(): Promise<string[]>;

  /** Present only when `capabilities` says so. */
  compact?(): Promise<void>;
  reload?(): Promise<void>;
  exportHtml?(): Promise<string>;
  rewind?(ref: string): Promise<{ editorText?: string }>;
  forkPoint?(ref: string): { resumeRef: string | null; text: string };
  rename?(title: string): string;

  updateWorkspace(workspace: Workspace): void;
  /** What to persist so this session can be reopened: a path, or an id. */
  resumeRef(): string | undefined;
  dispose(): void;
}
```

The host is the other half of the contract — the calls a backend makes inward,
all of which `SessionRuntime` already performs against Pi:

```ts
export interface AgentHost {
  emit(event: AgentEvent): void;
  commit(item: ChatItem): void;
  /** The gate (§9/§10). Resolves when the human answers, or immediately. */
  askPermission(toolName: string, input: unknown): Promise<{ allowed: boolean; reason?: string }>;
  notice(text: string, level: "info" | "warn" | "error"): void;
  renamed(title: string | undefined): void;
  editorText(): string;
  openComments(): FileComment[];
  resolveComment(id: string): FileComment | null;
  speak(text: string): void;
}
```

**`EventTranslator` is the shared part and should stay shared.** Its output is
already the protocol; only its input is Pi's. Make its assembly methods public —
`startAssistant`, `delta`, `thinking`, `endAssistant`, `toolStarted`,
`toolUpdated`, `toolCompleted`, `notice`, `setState` — and let each backend feed
it: `pi/events.ts` keeps `handle(AgentSessionEvent)`, `claude/events.ts` gets
`handle(SDKMessage)`. The interleaving rules that took work to get right (flush
the assistant text before a tool call so the transcript reads in order; only
commit a message with something in it) are then written once.

### Capabilities are a protocol concern, not a `try/catch`

```ts
export interface AgentCapabilities {
  rewind: boolean;        // §53, per message
  fork: boolean;          // §53
  compact: boolean;       // §54, manually
  autoCompaction: boolean;// §54, as a switch
  reload: boolean;        // §34
  exportHtml: boolean;
  extensionUi: boolean;   // §55, Pi only
  fileCheckpoints: boolean; // Claude only — see below
}
```

The browser hides an affordance it cannot use. A rewind button that throws "not
supported for this session" is worse than no button, and worse again because
§53's rewind is one of the app's better features and its absence should be
visible when choosing an agent, not discovered afterwards.

---

## The Claude backend

**One `query()` per loaded session, in streaming-input mode, held open.** Not
one per turn. Streaming input is what makes `interrupt()`, `setModel()`,
`getContextUsage()`, `supportedCommands()` and the hooks available at all; a
fresh `query()` per message would re-pay process start on every turn and lose
all of them. A turn is a push into an async queue the generator drains:

```ts
async function* input() {
  for await (const text of queue) {
    yield { type: "user", session_id: "", parent_tool_use_id: null,
            message: { role: "user", content: text } };
  }
}
```

The cost is a `claude` child process per *loaded* session. `evictIdleSessions`
(keep 4) already exists and now earns its keep; `dispose()` must call
`query.close()`.

**Permissions.** A `PreToolUse` hook, on every call, awaiting the existing gate:

```ts
hooks: {
  PreToolUse: [{ hooks: [async ({ tool_name, tool_input }) => {
    const { allowed, reason } = await host.askPermission(tool_name, tool_input);
    return allowed ? {} : { hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason ?? "Denied in Picone.",
    }};
  }}]}]
}
```

`classifyToolCall` lowercases the tool name, so `Bash`, `Read`, `Write`, `Edit`,
`MultiEdit`, `Glob` and `Grep` already classify correctly — a pleasant accident
of having written the policy around what a tool *does*. Four gaps to close in
`permissions/policy.ts`:

* `NotebookEdit` writes through `notebook_path`, which `writeTargets` does not
  look at, so it would pass the writable-root check unexamined.
* `WebFetch` and `WebSearch` classify as `null` — ungated. Reaching the network
  is not one of §9's three categories, and it should be a decision rather than
  an oversight.
* `Task` spawns a subagent whose own tool calls come back through the same hook
  (`parent_tool_use_id` is set) — so they *are* gated, but the permission card
  will say the subagent's tool without saying it was a subagent.
* Every card title says "Pi wants to run". It has to take the agent's name.

**Where Claude's own permission layer goes.** It is still running underneath
ours. Phase 0 decides between two shapes: hook as the gate with a permissive
`canUseTool` beside it as the backstop for whatever the CLI would otherwise
prompt for, or `permissionMode: "bypassPermissions"` so that Picone's gate is
unambiguously the only one. The second is more honest about who owns the
decision — §9 says Picone does — and more dangerous if our hook ever fails open.
Prefer the first if it works.

**The world the agent sees.** `cwd` is the workspace cwd, exactly as Pi's is;
`additionalDirectories` gets every other root, hidden ones included (§3), so
that `Read` can reach what the file tree deliberately does not show.
`systemPrompt: { type: "preset", preset: "claude_code", append: … }` takes the
same text §6 and §50 already build — `workspaceContext(workspace)` plus each
memory directory's own `AGENTS.md`. `settingSources: ["user", "project"]` so the
user's `~/.claude` skills, subagents and `CLAUDE.md` come in, which is the
analogue of Pi discovering the user's global skills. Note that isolation is not
total either way: with `settingSources: []` the probe still reported 35 tools and
44 slash commands, because plugins and CLI defaults are not settings.

**Picone's own tools** — `speak` (§29), `resolve_comment` and
`list_open_comments` (§23) — go in through `createSdkMcpServer`, in-process, no
subprocess. They arrive at the model as `mcp__picone__resolve_comment`; the
prompt text in `pi/tools.ts` needs no change, but the tool definitions do, since
`tool()` takes a Zod shape where Pi's `defineTool` takes TypeBox. Either add
`zod` for this file or hand-build the MCP server. Two definitions of the same
three tools is the wrong answer; a small shape-agnostic descriptor that both
adapters read is the right one.

**MCP servers** (§35) are passed to the SDK as `mcpServers` and Claude spawns its
own. Picone's `McpManager` keeps serving Pi. This means two connections to the
same server when both agents are loaded, which is wasteful and, for a stateful
server, potentially wrong. The alternative — proxying Picone's already-connected
tools into the in-process SDK server — needs a generic schema bridge and is
Phase 5 at the earliest. Say so in the UI rather than pretending it is one
connection.

**Sessions.** `sessionId` accepts a UUID, and Picone's session ids *are*
`randomUUID()` — so pass ours and there is no mapping table: one id, both sides.
`resume: id` reattaches after eviction or a restart. `renameSession(id, title)`
gives §26 the file-side name it needs, and the `title` option names a session at
creation. `SessionSummary.sessionFile` is Pi's word for this; the field
generalises to `resumeRef`, with `sessionFile` kept for the Pi rows already in
the database.

`ChatItem.entryId` (§53) holds a Pi entry id today. For Claude it holds the
SDK message `uuid`, which every frame carries — so the suffix-matching heuristic
in `syncEntryIds`, written because Pi never announces the mapping, is simply not
needed on this side. That function moves into the Pi backend.

**Context and compaction.** `getContextUsage()` maps onto `ContextUsage` field
for field. `compact_boundary` system messages carry `trigger` and
`pre_tokens`/`post_tokens`, which is more than §54's notices currently say.
Manual compaction is `/compact` sent as a prompt. Pi's auto-compaction *switch*
has no Claude equivalent, so `capabilities.autoCompaction` is false and the
settings row hides.

**Stats** (§36) come from the cumulative `result` message —
`total_cost_usd`, `usage`, `modelUsage`, `num_turns` — kept as the latest value
rather than summed, which is what the SDK's own doc comment insists on.

**Models.** `supportedModels()` returns `{value, displayName, supportedEffortLevels}`;
the probe saw `default`, `sonnet`, `claude-fable-5[1m]`, `opus[1m]`, `haiku`.
Picone's `ThinkingLevel` union already contains `low|medium|high|xhigh|max`, so
effort levels map straight onto `ModelOption.thinkingLevels` and the picker needs
no new concept — `off` and `minimal` simply never appear for a Claude model,
which is exactly what per-model `thinkingLevels` was built for (§ModelPicker).
`GET /api/models` currently instantiates Pi's `ModelRuntime` unconditionally; it
takes an `agent` parameter and asks the right backend.

**What Claude has that Pi does not.** Worth building once the rest works:
`rewindFiles(userMessageId)` with `enableFileCheckpointing` restores the *files*
to their state at a message, not just the conversation — §53 rewinds the talk and
leaves the disk where it is, and this is the missing half. `supportedAgents()`
exposes subagents. Task notifications would give the transcript real rows for
background work.

**What Pi has that Claude does not.** The extension UI (§55) has no analogue —
`onUserDialog` and `onElicitation` are the nearest thing and they are MCP
surfaces, not extension surfaces. Per-message rewind in place is Pi's session
tree; Claude's `resume` + `resumeSessionAt` rebuilds by restarting the query,
which is a different operation with a different cost, so `capabilities.rewind`
is false for Claude in the first version and revisited in Phase 5.

---

## Choosing an agent

`+` creates a session immediately today, in two places (`SessionList`,
`TabBar`). Keep the click: it makes a session with the workspace's default
agent. Add a `▾` beside it — and a long press on touch — offering the agents
that are actually available, most recently used first. Choosing one also sets
the workspace default, the same way choosing a model does (§34: the JSON is the
persistent policy).

Both kinds of session live in one workspace and one list, so a row and a tab
need a small agent glyph. A glyph, not a word: the session list is already
carrying a title, an excerpt and a timestamp.

An agent that cannot run should not be offered. If the SDK is not installed or
no `claude` executable can be found, the menu shows Pi alone, and Settings has
one line saying why rather than a broken option that fails on click.

### Protocol

```ts
export type AgentKind = "pi" | "claude";

// SessionSummary
agent: AgentKind;
capabilities: AgentCapabilities;
resumeRef?: string;          // supersedes sessionFile

// ClientMessage
| { type: "new_session"; title?: string; agent?: AgentKind }

// WorkspaceFile
agent?: AgentKind;                              // default for new sessions
models?: Partial<Record<AgentKind, WorkspaceModel>>;
model?: WorkspaceModel;                         // still read, as Pi's
```

`model` becoming `models` is the same back-compat move `directories` → `cwd` +
`context` already made: the old key keeps working and means Pi.

### Database

`sessions` gains `agent TEXT NOT NULL DEFAULT 'pi'` and `resume_ref TEXT`,
through the `ALTER TABLE … ADD COLUMN` in a `try/catch` that `forked_from`
established. `session_file` stays for the rows that have one.

---

## Phases

**0 — Spike.** A script under `apps/server/scripts/`, wired to nothing, that
runs one Claude turn against a scratch directory with the `PreToolUse` gate in
place and prints the translated `AgentEvent`s. It exists to answer the three
unverified questions above. A day at most, and it either de-risks the rest or
changes it.

**1 — The seam.** Extract `Session`, `AgentBackend`, `AgentHost`; move today's
runtime into `PiBackend`; make `EventTranslator`'s assembly public. No behaviour
change, no protocol change, every test still green. This is the largest diff and
the one worth doing on its own merits.

**2 — `ClaudeBackend`.** Prompt, stream, abort, model, context, commands,
permissions through the hook. Capabilities minimal: no rewind, no fork, no
export, no extension UI. A Claude session you can talk to, that respects the
gate and shows up in the transcript like any other.

**3 — The picker.** Protocol, database, the `▾` menu, the glyph, per-agent
models endpoint, capability-driven affordances.

**4 — Parity.** The `policy.ts` gaps, Picone's three tools as an SDK MCP server,
MCP config passthrough, memory context and the workspace description in the
system prompt, skills filtering from `WorkspaceResources`, `renameSession` for
§26.

**5 — The extras.** File checkpointing and `rewindFiles`; fork via
`resumeSessionAt`; subagents and task notifications in the transcript; the MCP
proxy that would let both agents share one connection.

---

## Costs and risks, plainly

**283 MB.** The SDK is 4 MB but pulls a platform binary as an optional
dependency — `@anthropic-ai/claude-agent-sdk-win32-x64` is 283 MB on this
machine. Three ways out, and the plan takes all three in order: make the SDK
itself an optional dependency so a Picone without it still builds and runs, with
the agent picker simply not offering Claude; resolve the executable as
*setting → `claude` on `PATH` → bundled binary*, since this machine already has
2.1.228 on the path and the SDK is 0.3.228 of the same build; and install with
`--omit=optional` where the path is known good.

**Version coupling.** SDK `0.3.x` tracks CLI `2.1.x` build for build. A user
whose `claude` on `PATH` has moved on is a mismatch we will not see until a
control request fails. Log the CLI version from the `init` frame at session
start, and say it in Settings.

**One process per loaded session**, each holding its own MCP connections.
Eviction is already there; the number to watch is 4.

**Auth in production.** It worked here because this machine is logged in.
`PiconeServe` runs as a service, and the service account has its own `~/.claude`
— which is probably not logged in. Either the service runs as the user, or
`ANTHROPIC_API_KEY` goes in its environment. This will be the first thing that
breaks on deploy and it is worth writing down before it does.

**Two permission systems** for the same tool call, and ours only wins if the
hook is genuinely the gate. Phase 0 is mostly about being sure of that.

**Whose session file is it.** Claude writes its own transcript under
`~/.claude/projects/`; Picone keeps its own (§37), which holds things no agent
ever sees — permission cards, comment injections, notices. That divergence
already exists for Pi and is the right shape; the new part is that a Claude
session can also be opened in the `claude` CLI, exactly as a Pi session can be
opened in Pi's, and both will be missing the same half.
