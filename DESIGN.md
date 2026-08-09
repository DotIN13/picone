# Picone — Architecture & Design

A browser-native coding agent powered by Pi.

This document describes the system as designed **and built**. Section numbers
`§1`–`§41` are referenced from comments throughout the source, so they are
stable; where the implementation diverged from the original plan, the section
says so rather than being renumbered. Sections `§42`–`§48` cover subsystems that
were added during the build.

Known gaps live in [TODO.md](TODO.md).

---

## 1. Product definition

The product feels like a lightweight web IDE built around an agent, not a
terminal UI rendered in a browser.

```text
Workspace
Files
Sessions
Comments
Agent
```

Core principles:

* Exactly one workspace is open in the web interface at a time.
* A workspace is represented by a portable JSON file.
* The workspace JSON describes directories, MCPs, skills, permissions, model,
  and voice settings.
* Sessions belong to the workspace, not to a directory.
* Pi owns context management, history, compaction, and model-facing state.
* The application injects workspace metadata only when it changes.
* The interface has a VS Code-style file browser.
* Sessions and files share one tab strip.
* File tabs are read-only and commentable.
* Comments are injected into the target session immediately.
* File, shell, and git permissions are sufficient.
* Voice input and output are browser-native.

> **Diverged from plan.** The original called for a single fixed Chat tab.
> Sessions are now ordinary tabs (§13, §26), so several sessions can be open and
> visible at once.

---

## 2. Workspace model

A workspace is a JSON file. It is the primary source of truth: readable,
editable, portable, versionable, easy to back up, easy to share, possible to
write by hand.

```json
{
  "version": 1,
  "name": "Acme",

  "directories": [
    "/Users/me/code/acme-web",
    "/Users/me/code/acme-api"
  ],

  "instructions": [
    "Frontend and backend often change together."
  ],

  "skills": [
    { "name": "release", "path": "~/.pi/agent/skills/release" }
  ],

  "mcp": {
    "linear": { "url": "http://localhost:8123/mcp", "enabled": true }
  },

  "permissions": {
    "files": "allow",
    "shell": "ask",
    "git": "ask"
  },

  "model": { "provider": "anthropic", "model": "claude-opus-4-5", "thinking": "medium" },
  "voice": { "input": true, "output": true }
}
```

No internal database representation is required for workspace configuration. A
database stores runtime state only (§37).

---

## 3. Opening a workspace

```text
workspace.json
      ↓
Workspace loader
      ↓
Validate
      ↓
Start MCP servers
      ↓
Create or reattach a session (loads skills, injects workspace context)
      ↓
Open workspace UI
```

Only one workspace is active at a time. Switching workspace disposes every
session, stops MCP servers, drops file watches, and opens the other one.

**A workspace can be created from any directory.** Requiring a hand-written JSON
file before anything could be opened made the product unusable on first run.
`POST /api/workspace/create` takes a directory, writes
`<name>.workspace.json` into it with `directories: ["."]` — so the file travels
with the checkout — and opens the result. The alternative location, Picone's own
data directory, exists for projects that should not carry a Picone file.

**The picker is one path field plus a listing.** Typing filters; the listing
below is the completion surface, always visible. Clicking a folder descends,
clicking a workspace file opens it, and *Create* makes a workspace for whichever
folder is on screen. Recent workspaces sit underneath and hide while filtering.
Non-workspace files are listed for orientation but are not clickable — offering
`package.json` and then failing validation would be a lie.

Path handling is cross-platform by construction (`files/paths.ts`): the
separator the user types is echoed back, `~` expands while preserving a trailing
separator, Windows drive letters are enumerated for the root listing, `D:` and
`D:/` both mean that drive's root, and matching is case-insensitive only where
the filesystem is.

The picker is deliberately *not* confined to the workspace roots — the user is
choosing where a workspace lives on their own machine, and the server only ever
binds to localhost.

The last opened workspace is restored on server start. A workspace whose Pi
session file has vanished still opens; a fresh session is created instead.

---

## 4. Workspace file schema

```ts
interface WorkspaceFile {
  version: 1
  name: string
  directories: string[]
  instructions?: string[]
  skills?: { name: string; path: string }[]
  mcp?: Record<string, WorkspaceMcpConfig>
  permissions?: {
    files?: PermissionSetting
    shell?: PermissionSetting
    git?: PermissionSetting
  }
  model?: { provider?: string; model?: string; thinking?: string }
  voice?: { input?: boolean; output?: boolean }
}

type PermissionSetting = "allow" | "ask" | "deny"
```

Validation is hand-written (`workspace/schema.ts`) so error messages read well
for someone who wrote the JSON by hand. Defaults: `files: allow`, `shell: ask`,
`git: ask`, voice on.

Paths accept `~` and resolve relative entries against the workspace file's own
directory, so a workspace can sit inside the repository it describes.

A directory that does not exist is a diagnostic, not a failure — a shared
workspace file still opens on another machine.

---

## 5. Filesystem model

No mount aliases, no virtual filesystem. The workspace names directories and Pi
uses ordinary absolute paths.

The workspace is not tied to a `cwd`. One session works across every configured
directory. An active working directory exists only as transient shell state.

Pi's session services are cwd-bound, so the first existing root is used as the
process cwd. That choice affects only where Pi looks for project-local resources
and stores its session file — it does not constrain the agent.

---

## 6. Pi owns context

There is no custom context resolver. Pi owns conversation history, context
management, compaction, tool results, file reads, skill loading, and session
state.

The application contributes exactly one thing at session creation: a compact
workspace description, injected as a virtual `AGENTS.md` through the resource
loader.

```text
You are operating in the workspace "Acme".

The workspace contains these directories:

- /Users/me/code/acme-web
- /Users/me/code/acme-api

Workspace instructions:

- Frontend and backend often change together.
```

It is never re-injected. Configuration changes are announced as they happen
(§34).

---

## 7. High-level architecture

```text
┌───────────────────────────────────────────────────────────┐
│                     Browser (SolidJS)                     │
│                                                           │
│ Tabs · Files · Chat · Comments · Voice · Extension UI     │
└────────────────────────┬──────────────────────────────────┘
                         │
                  HTTP + one WebSocket
                         │
                         ▼
┌───────────────────────────────────────────────────────────┐
│                     Agent Server                          │
│                                                           │
│ Workspace · Sessions · Files · Comments · Permissions     │
└───────────────┬──────────────────────────┬────────────────┘
                │                          │
                ▼                          ▼
┌────────────────────────────┐   ┌──────────────────────────┐
│      Workspace Runtime     │   │       MCP Manager        │
│                            │   │                          │
│ workspace JSON             │   │ stdio / streamable HTTP  │
│ skills · permissions       │   │ tools → Pi custom tools  │
└──────────────┬─────────────┘   └──────────────────────────┘
               │
               ▼
┌───────────────────────────────────────────────────────────┐
│                     Pi Runtime (SDK)                      │
│                                                           │
│ session · history · context · tools · compaction          │
│                                                           │
│      ┌───────┬───────┬──────┬───────┬──────────────┐      │
│      ▼       ▼       ▼      ▼       ▼              ▼      │
│    files   shell   git   speak   comments   MCP tools     │
└───────────────────────────────────────────────────────────┘
```

The server provides transport and product semantics. Pi owns the agent loop.

> **Diverged from plan.** There is no separate voice service. Speech recognition
> and synthesis run in the browser (§28, §29), so no audio leaves the machine.

---

## 8. Pi adapter

The integration is thin. `SessionRuntime` (`pi/runtime.ts`) wraps one
`AgentSession`:

```ts
class SessionRuntime {
  static create(options): Promise<SessionRuntime>

  prompt(text, source, displayText?): Promise<void>
  steer(text, source, displayText?): Promise<void>
  abort(): Promise<void>

  injectComment(modelText, displayText): Promise<void>
  respondToPermission(requestId, decision): void
  answerExtensionUi(answer): void

  setModel(provider, model, thinking?): Promise<void>
  updatePermissions(permissions): void
  notifyWorkspaceChange(text): Promise<void>

  snapshot(): AgentEvent
  commands(): SlashCommand[]
  dispose(): void
}
```

`displayText` exists because the model-facing text and the transcript text
differ for structured input — a file comment is a long structured block to the
model and a compact card to the human.

The frontend never sees a Pi type. Everything crosses the boundary as the
protocol in §30.

---

## 9. Permissions

Three categories, three settings:

```text
files   allow | ask | deny
shell   allow | ask | deny
git     allow | ask | deny
```

`files` covers read, write, edit, delete, rename, create. `shell` covers process
execution. `git` covers operations that mutate repository state — commit,
checkout, merge, rebase, push, and so on. Read-only git (`status`, `diff`,
`log`, `show`, `blame`, …) always runs.

Classification (`permissions/policy.ts`) does not trust tool names alone:

* Known file tools → `files`.
* Known shell tools → `shell`, then re-classified as `git` if every segment of
  the command line is a git invocation.
* **Anything with a `command`, `cmd`, or `script` string argument → `shell`.**
* Anything with a path plus content/patch arguments → `files`.

That fallback matters. Pi extensions contribute their own shell tools — a `pwsh`
tool on Windows, for instance — and a name-only allowlist would let them execute
processes ungated. This was a real bypass, found during testing.

A compound command takes the strictest category present: `git push && npm test`
is a shell request, not a git one.

---

## 10. Permission requests

When a category is `ask`, the run pauses and a card appears in the transcript:

```text
Pi wants to run          [shell]

  pnpm test

Directory: /Users/me/code/acme-api

[Allow once] [Allow for session] [Deny]
```

The gate parks a promise keyed by request id; the answer resolves it. *Allow for
session* remembers both the exact command and the category, so repeated work
stops asking. Denial returns a reason to the model telling it not to retry.

The workspace JSON remains the persistent policy. Session grants are ephemeral
and die with the session.

---

## 11. Main UI structure

```text
┌──────────────────────────────────────────────────────────────────┐
│ ▣ Acme ▾  Thinking          probe status  2 MCP ● ☀ ⚙            │
├─────────────────┬────────────────────────────────────────────────┤
│ Files │Sessions │ [Auth redesign ×][DESIGN.md ×][auth.ts ×] +     │
│                 │                                                │
│ 🔍 Filter…      │                                                │
│ ▾ acme-web      │              Active tab                        │
│   ▾ src         │                                                │
│     App.tsx     │                                                │
│     auth.ts   M │                                                │
│                 │                                                │
│ ▾ acme-api      │                                                │
│                 │                                                │
│ COMMENTS · 2    │                                                │
│ MCP  ● linear   │                                                │
├─────────────────┴────────────────────────────────────────────────┤
│ Ask anything, or / for commands                                  │
│ 🎙  ✦ claude-opus-4-5  MEDIUM                              ↑      │
└──────────────────────────────────────────────────────────────────┘
```

Two primitives: **sidebar** and **tabs**. Model selection and dictation sit in a
control row under the input, not in the title bar.

The same two primitives rearrange for small screens rather than being replaced —
see §47.

---

## 12. File browser sidebar

Each configured directory is a root node. The tree lazy-loads one level at a
time; nothing recurses on startup.

Features: expand/collapse, open file, refresh, filename filter, git status
marks. Build and vendor directories (`node_modules`, `.git`, `.next`, …) and
dotfiles are hidden.

Git status comes from `git status --porcelain` per root, refreshed on a timer
and after file changes. A root that is not a repository simply reports nothing.

Below the tree: a comment navigator (§21) and MCP server status (§32).

---

## 13. Tabs

Sessions and files share one tab strip. Every tab is closable and every tab can
be dragged to reorder.

```text
[Auth redesign] [Fix checkout] [DESIGN.md ×] [auth.ts ×]  +
```

* **Session tabs** show the session title, a spinner while that session's agent
  is working, and a `+` at the end of the strip creates a new one. Closing a
  session tab hides it — the session keeps running on the server and reopening
  it from the sidebar restores the transcript.
* **File tabs** are closable, read-only, and commentable, with a badge counting
  unresolved comments.

Every open tab stays mounted, so a background session keeps streaming while the
user reads something else.

The user does not edit files from these tabs. The agent remains responsible for
file mutation, which keeps the collaboration model simple.

> **Diverged from plan.** The plan specified one fixed, unclosable Chat tab.

---

## 14. Chat surface

A session tab shows user messages, assistant messages, thinking (collapsed),
tool calls, permission requests, extension output, and notices.

Tool calls render as one compact row — tool name, a one-line summary of the
arguments, status — expanding to output, or to a coloured unified diff when the
tool returned a patch. File-shaped tool calls offer **Open file**, which opens a
tab without navigating away from the conversation.

---

## 15. Read-only file tabs

* **Code** — CodeMirror 6, read-only, line numbers, syntax highlighting from the
  theme's syntax tokens, selection.
* **Markdown** — rendered by default with a Rendered/Source toggle; source uses
  the same CodeMirror view.
* **Plain text** — the code view with no grammar.
* **Binary** — size only.

Large files are truncated server-side and marked as such.

The common capability is: **select text → comment**.

---

## 16. File comments

```ts
interface FileComment {
  id: string
  workspaceId: string
  sessionId: string
  path: string
  matcher: string        // the selected text — the primary anchor
  lineStart?: number
  lineEnd?: number
  body: string
  status: "open" | "addressed" | "resolved"
  createdAt: string
}
```

---

## 17. Why matcher + lines

The selected text is the locator; lines are a hint. No revision ids, no
persistent anchors, no re-anchoring engine.

The agent can search for the matcher, read the indicated lines, and understand
nearby text. If the file changes enough that the matcher is gone, the comment
still carries enough meaning to be useful.

In the rendered markdown view the DOM has no line numbers, so line hints are
recovered by locating the selected text in the source — exact match first, then
a joined-line scan, then a prefix match. A miss is acceptable.

---

## 18. Creating a comment

Selecting text raises a lightweight `💬 Comment` action. Clicking it opens an
inline composer showing the quoted selection and its line range.

On submit:

1. Save the comment.
2. Show it against the anchored lines.
3. Inject it into the active session.
4. If Pi is working, steer. Otherwise send it as the next user input.

The two-step interaction — action, then composer — keeps a stray selection from
opening a text box in the user's face.

Clicking or typing inside the composer collapses the browser's selection; the
composer guards against reading that as a deselection. This was a real bug.

---

## 19. Comment injection

The comment stays structured internally and becomes text at the Pi boundary:

```text
The user left a comment on:

/Users/me/code/acme-api/DESIGN.md

Around line 42.

Selected text:

"""
The authentication service will introduce a Redis-backed session layer.
"""

Comment:

"""
Let's avoid adding another stateful service.
"""

If the exact selected text has moved or changed, search the file for it. When you
have acted on this feedback, call mark_comment_addressed with commentId "…".
```

This enters the normal message flow. There is no comment-processing subsystem.

The transcript shows a compact card instead — filename, line, quoted selection,
comment body.

---

## 20. Comments during active runs

```text
Pi is working
      │
Human opens DESIGN.md in another tab
      │
Human reads the draft
      │
Human leaves a comment
      ▼
session.steer(comment)
      ▼
Pi sees the feedback immediately
```

Every tab stays mounted precisely so this works: reading a file never pauses the
run, and the comment reaches the session that produced the work.

---

## 21. Comment display

Comments render as cards anchored to their lines, with the commented lines
highlighted in the gutter:

```text
42 │ The authentication service will introduce
43 │ a Redis-backed session layer.
   │ ┌──────────────────────────────────────────┐
   │ │ Let's avoid another stateful service.    │
   │ │ Comment on lines 42–43   [addressed]  ✓  │
   │ └──────────────────────────────────────────┘
```

The same card appears in the markdown view and, in condensed form, in the
sidebar comment navigator. All three are one component with a display and an
editor variant.

---

## 22. Comment lifecycle

```text
open        the user created it
addressed   the agent believes it acted on it
resolved    the human considers it done
```

No `seen` state. Receipt is inferable from session events.

---

## 23. Agent handling of comments

The agent gets two tools:

```ts
mark_comment_addressed({ commentId: string })
list_open_comments()
```

The agent may mark a comment *addressed*. Only the human marks it *resolved*.
That gives the human the final say.

---

## 24. File tab refresh behaviour

```text
Pi writes file → filesystem watcher → file.changed → banner in the tab
```

The tab never swaps content underneath an active selection. It shows:

```text
⚠ This file changed on disk.   [Refresh]
```

Only files with an open tab are watched, reference-counted across clients.
Watching whole repositories would cost far more than the one thing needed.

---

## 25. Chat, files, and voice are equal surfaces

```text
Chat message  ─┐
File comment  ─┼─→ Pi session
Voice message ─┘
```

The user moves between talking about the work, reading the work, and commenting
on the work without copying snippets into chat.

---

## 26. Session model

A workspace has many sessions. Several can be open as tabs; the one that
receives chat, voice, and comments is the **last-focused session tab**.

Opening a file does not create or change a session, and does not orphan the
composer — input still goes to the session you were last in.

Each session keeps its own transcript and agent state client-side, so a
background session's events accumulate in its own tab rather than being dropped.

Server-side, the four most recently used idle sessions stay loaded. Beyond that,
idle sessions are disposed and rebuilt from their Pi session file on demand. A
streaming session is never evicted.

---

## 27. Sidebar sections

The sidebar has two modes, **Files** and **Sessions**, plus always-visible
comment and MCP sections beneath the tree. The session list shows title, last
activity, current model, and a spinner while running; it renames, deletes, and
opens sessions as tabs.

---

## 28. Voice input

```text
microphone → streaming STT (Web Speech API) → live transcript → composer
```

The transcript lands in the composer so the user sees what was recognised before
sending. During an active run, sending steers.

Browser-native: no service to run, no audio leaves the machine. Disabled when
the browser lacks support or the workspace turns it off.

---

## 29. Voice output

An explicit agent tool, registered only when the workspace enables it:

```ts
speak({ text: string })
```

The agent chooses when speaking is useful — approval needed, long task finished,
direction changed. Assistant responses are not spoken automatically. Speaking
again interrupts what is playing.

---

## 30. Event protocol

The browser has its own protocol. Pi's event shapes never reach it.

```ts
type AgentEvent =
  | { type: "session.snapshot"; sessionId; items; state }
  | { type: "user.message"; id; text; source; at }
  | { type: "assistant.start" | "assistant.delta" | "assistant.thinking" | "assistant.end"; … }
  | { type: "extension.message"; id; customType; text; at }
  | { type: "tool.started" | "tool.updated" | "tool.completed"; toolCall }
  | { type: "permission.requested"; request }
  | { type: "permission.resolved"; requestId; decision }
  | { type: "file.changed"; path; mtime }
  | { type: "comment.created" | "comment.updated"; comment }
  | { type: "voice.speak"; text }
  | { type: "agent.state"; state }
  | { type: "notice"; text; level }
  | { type: "workspace.updated"; workspace }
  | { type: "session.list"; sessions; activeSessionId }
  | { type: "session.commands"; sessionId; commands }
  | { type: "extension.ui.prompt"; prompt }
  | { type: "extension.ui.prompt.closed"; id }
  | { type: "extension.ui.update"; update }
  | { type: "mcp.state"; servers }
```

Translation lives in `pi/events.ts`. Notably it splits Pi's `message_end` by
role: `assistant` finalises the streaming message, and `custom` becomes an
`extension.message` row (§44).

---

## 31. WebSocket model

One socket for the whole app:

```text
WS /ws
```

Every server frame is `{ sessionId, event }`, with `sessionId: null` for
workspace-level events. The client routes by session id, which is what lets
background sessions accumulate correctly.

Client → server:

```text
prompt · steer · abort            (optionally targeting a session)
permission_response
file_comment · resolve_comment
watch_file · unwatch_file
select_session · new_session
extension_ui_answer · editor_text
```

The socket reconnects with backoff and queues anything sent while down. On
connect the server replays session list, workspace, MCP state, the active
session's snapshot, and its slash commands.

> **Diverged from plan.** The plan proposed `WS /sessions/:id/events`. A single
> socket with session-tagged frames turned out simpler once several sessions can
> be open at once.

---

## 32. MCP

MCP configuration lives in the workspace JSON and is scoped to the workspace,
never to a repository.

```text
workspace JSON → MCP manager → connect enabled servers → tools exposed to Pi
```

Pi has no built-in MCP, so `mcp/manager.ts` is a real client built on
`@modelcontextprotocol/sdk`, supporting stdio and streamable HTTP. Each remote
tool becomes a Pi custom tool named `<server>__<tool>`, with the server's JSON
Schema passed through verbatim.

Failures are reported per server, never fatal. Server state — connected, error,
disabled, tool count — is visible in the sidebar and settings.

MCP tools go through the permission gate like anything else: one with a
`command` argument is a shell request (§9).

---

## 33. Skills

Skills live in the workspace JSON and are handed to Pi's resource loader as
additional skill paths. Pi owns how they enter context and execute. There is no
parallel context-management system around them.

Pi *already* discovers global skills from `~/.pi/agent/skills` and
`~/.agents/skills`, along with global extensions and prompt templates — nothing
is needed from Picone for those to work. Global settings (§48) add extra
directories on top.

---

## 34. Workspace updates

Editing configuration through the UI writes `workspace.json` and then tells the
running session what changed:

```text
Workspace update:

Permissions were updated:

shell: allow
```

The message is also shown in the transcript as a notice, so the agent's reply to
it does not look unprompted.

Permission changes apply to live sessions immediately. Directory, instruction,
MCP, and skill changes are announced; MCP servers restart. Model changes apply
immediately to the session that made them (§45).

---

## 35. Workspace settings

A side drawer with sections: General, Directories, Skills, MCP, Permissions,
Voice, Model. Every edit writes back to `workspace.json`, which stays the source
of truth. **Open workspace JSON** opens the file itself as a read-only tab.

Load diagnostics — missing directories, missing skill paths — surface in
General.

---

## 36. Project structure

```text
apps/
  server/
    src/
      index.ts            bootstrap: http + ws
      app.ts              the one open workspace and its sessions
      http.ts  ws.ts  hub.ts
      db.ts               sqlite runtime state
      workspace/          schema · loader · writer
      files/              browser · reader · watcher · git
      comments/           comments · matcher
      permissions/        policy · gate
      pi/                 runtime · events · tools · extension-ui
      mcp/                manager
      util/               paths
  web/
    public/assets/fonts/  Inter · JetBrains Mono
    src/
      main.tsx  App.tsx  store.ts
      styles/             colors · theme · tailwind-theme · base · app · markdown · codeview
      components/ui/      button · primitives · drawer · line-comment · icon
      components/         feature components
      lib/                api · socket · languages · selection
      voice/              speech
packages/
  protocol/               type-only wire contract
```

`packages/protocol` contains no runtime values, so both sides import it directly
with no build step and every import is erased at compile time.

---

## 37. Storage

Workspace configuration lives only in the JSON file.

Runtime state is SQLite (`node:sqlite`, no native dependency) under
`PICONE_DATA_DIR`, default `~/.picone`:

```text
sessions            id, workspace, title, pi session file, timestamps
messages            the rendered transcript
comments            path, matcher, line range, body, status
recent_workspaces
ui_state            last opened workspace
```

Conversation history itself is Pi's, in its own JSONL session files under
`~/.pi/agent/sessions/<encoded-cwd>/`. The `sessions.session_file` column is the
only link between the two stores.

`messages` is not a duplicate of Pi's transcript. Pi's file is model-facing; this
is what the browser draws — compact comment cards, permission decisions, tool
status and patches. Re-deriving UI state from model state on every reconnect
would be the wrong direction.

---

## 38. Implementation status

Built and verified end to end:

```text
Pi in the browser        streaming · tool calls · abort · steering · reconnect
Workspace JSON           schema · open · validate · recents · settings
File browser             multiple roots · lazy expansion · search · git status
Tabs                     sessions and files · reordering · read-only viewers
Permissions              files/shell/git · allow/ask/deny · cards
File comments            selection · matcher · composer · inline display
Comment → session        steer when active, otherwise next input
File watching            open tabs only · refresh banner
MCP and skills           from workspace JSON, scoped to the workspace
Voice                    dictation and the speak tool
Slash commands           §43
Extension UI             §44
Model selection          §45
```

Remaining work is in [TODO.md](TODO.md): no committed tests, a single large web
bundle, an unexercised MCP HTTP transport, and stdout-only logging.

---

## 39. Non-goals

Still not built, still deliberate:

```text
virtual mounts
custom context resolution
revision-aware comments
collaborative file editing
CRDTs
LSP-powered IDE features
complex per-path permissions
full VS Code replacement
```

---

## 40. Core interaction

```text
Open workspace.json
        ↓
File tree appears
        ↓
"Design the new auth system."
        ↓
Pi investigates several repositories
        ↓
Pi creates DESIGN.md
        ↓
User opens DESIGN.md in a tab, reads while Pi keeps working
        ↓
User selects a paragraph → "Don't introduce Redis."
        ↓
Comment steers the running session
        ↓
Pi adjusts the design, marks the comment addressed
        ↓
Tab shows "changed on disk" → user reviews again
```

The loop is: ask → agent works → open → review → comment → agent reacts →
review. There should be almost no friction between those steps.

---

## 41. Architectural thesis

The product does not invent an agent framework around Pi.

Pi owns reasoning, conversation, context, history, compaction, and tool usage.
The application provides the environment: workspace selection, the workspace
file, sessions, file browser, tabs, comments, permissions, MCP, skills, voice,
and a browser home for Pi's extension UI.

```text
                  workspace.json
                        │
                        ▼
┌───────────────────────────────────────────────────┐
│                  Web Workspace                    │
│                                                   │
│ Files      Chat      Comments      Voice          │
│   │          │           │           │            │
│   └──────────┴─────┬─────┴───────────┘            │
│                    ▼                              │
│               Pi Session                          │
│                    │                              │
│            files / shell / git                    │
└───────────────────────────────────────────────────┘
```

The workspace file describes the world. Pi decides how to operate within it. The
browser makes that world visible. Comments let the human interact with the work
itself instead of translating every piece of feedback back into a prompt.

---

## 42. UI stack and design system

The web app follows [opencode](https://github.com/anomalyco/opencode)'s design
system and conventions.

* **SolidJS** with one `createStore`. The WebSocket reducer folds straight into
  the store; there is no separate state layer.
* **Tailwind v4** for layout, with opencode's `v2` semantic tokens exposed as
  utilities (`bg-v2-background-bg-base`, `text-v2-text-text-muted`).
* **Kobalte** for accessible primitives — button, dialog, select, switch,
  tooltip, text field, popover.
* **Corvu** for the settings drawer, including drag-to-dismiss and a scrim that
  tracks the drag position.
* **CodeMirror 6** for code tabs; **marked** + **DOMPurify** for markdown, which
  is sanitized because it renders model output and arbitrary repository files.
* **Lucide** icons, imported one glyph at a time, behind a name map so swapping
  an icon never touches a call site.
* **Inter** and **JetBrains Mono**, self-hosted, so the app works offline.

Styling follows opencode's split: Tailwind utilities for layout, attribute-driven
CSS for designed components.

```css
[data-component="button"][data-variant="contrast"] { … }
[data-slot="line-comment-shell"] { … }
```

Colour, elevation, and syntax tokens live in `styles/colors.css` and
`styles/theme.css`. Light and dark are the same semantic tokens flipped by
`data-color-scheme` on `<html>`, set before first paint to avoid a flash.

One typography detail worth remembering: the UI runs at weight 440, and CSS
font-matching rounds 400–500 *upward*, so monospace text silently picked
JetBrains Mono Medium until code contexts were pinned back to 400.

---

## 43. Slash commands

Typing `/` opens a filtered menu. Arrow keys choose, Tab completes, Enter sends,
Escape dismisses.

Two sources:

* **Pi commands** — prompt templates, skills, and extension commands, read from
  `pi.getCommands()` on the extension API and pushed per session, because
  extensions and skills differ between sessions. Picone only completes the
  token; Pi expands templates and executes extension commands itself.
* **App commands** — handled in the browser and never sent: `/new`, `/close`,
  `/settings`, `/theme`, `/sidebar`.

Each entry shows its source, so it is clear what will happen.

---

## 44. Extension UI protocol

Pi extensions talk to the user through an `ExtensionUIContext`, which in the CLI
draws a TUI. Picone implements the same surface against the browser — the same
thing `runRpcMode` does over stdio — so extension commands work here too.

Four methods block until the human answers, and map onto dialogs:

```text
select(title, options)   →  value | cancelled
confirm(title, message)  →  confirmed
input(title, placeholder)→  value | cancelled
editor(title, prefill)   →  value | cancelled
```

Five are fire-and-forget:

```text
notify        →  a transcript notice at info / warn / error
setStatus     →  a pill in the title bar
setWidget     →  a monospace block above or below the composer
setTitle      →  the session tab label
setEditorText →  the composer contents
```

`getEditorText()` reads a debounced mirror of the composer. `timeout` and
`signal` resolve to the caller's default rather than rejecting, and the server
emits `extension.ui.prompt.closed` so the browser dismisses the dialog — an
extension can never wedge a session.

`mode` is reported as `"rpc"` and `hasUI` is true, which is what extensions
branch on before offering a dialog.

Two hard-won details:

* **Most extension output is not the UI context at all.** Extensions report
  results with `pi.sendMessage({ display: true })`, which arrives as a
  `message_end` event with `role: "custom"`. Those get their own transcript row
  (§30). This, not the dialogs, is what makes commands like `/subagent-cost`
  visible.
* **Every member of `ExtensionUIContext` must exist**, including the terminal-only
  ones. A missing method is not graceful degradation — the extension throws
  `ctx.ui.x is not a function` and the whole command fails.

Not supported, as in RPC mode: component-factory widgets, custom message
renderers, overlays, and keybindings. They are TUI-component-shaped and have no
text representation to cross the wire.

---

## 45. Model selection

A picker under the composer, with search and a thinking-level strip, showing the
model the active session is actually running.

Choosing a model does two things:

1. `session.setModel()` on the live session — it takes effect on the next turn,
   mid-conversation.
2. Writes the choice to `workspace.json`, so new sessions inherit it.

The thinking badge reflects the level Pi is really using, which may be clamped
up from what was requested. Showing the request rather than the reality would be
a lie.

**Thinking levels are per model, not a fixed list.** Pi's `Model` carries
`reasoning` and a `thinkingLevelMap` in which an explicit `null` marks a level
unsupported and a missing key means "provider default", which is supported. The
spread is wide enough that a single list would be wrong nearly everywhere:

```text
gpt-4o, gemini-2.0-flash    no thinking at all
gemini-3.5-flash            everything except off — it cannot be turned off
gpt-5.4-mini                off, low, medium, high, xhigh
o3                          low, medium, high
deepseek-v4-pro             off, high, xhigh, max
```

`/api/models` reports the supported set per model, and the picker offers only
those, hiding the control entirely for a model that has none and badging such
models in the list. Switching models carries the current level across when the
target supports it, otherwise the nearest one by effort — clamping should
preserve intent, not reset it.

---

## 46. What runs where

```text
Pi                      reasoning · conversation · context · compaction
                        tool execution · session files · skills
                        prompt templates · extensions

Picone server           workspace file · session lifecycle · permissions gate
                        file reads and watching · comments · MCP client
                        event translation · extension UI transport

Browser                 tabs · file viewers · comment anchoring · composer
                        speech recognition and synthesis · theming
```

When in doubt, the question is: does this belong to the agent's understanding of
the work, or to the human's view of it? The first is Pi's. The second is ours.

---

## 47. Responsive and native behaviour

The app installs as a PWA and is expected to be usable on a phone, not merely to
survive there. There is one layout that rearranges, not a separate mobile build.

**Three sizes.**

```text
compact   < 768px    sidebar is an overlay, dialogs become bottom sheets
medium    768–1023   narrower sidebar column, narrower settings drawer
desktop   ≥ 1024      as described above
```

`compact` and `coarse` (touch) are reactive `matchMedia` signals published into
the store, so components branch on state rather than duplicating breakpoints.

**Viewport.** `100dvh` for the shell so it follows collapsing browser chrome,
`viewport-fit=cover` plus `env(safe-area-inset-*)` padding so it paints under
the notch without putting controls there, and `overscroll-behavior: none` on the
shell with `contain` on inner panes, so nothing rubber-bands the whole page.

**Keyboard.** `visualViewport` is tracked and published as `--keyboard-inset`.
The composer and the docked comment sheet offset by it, so the input stays above
the on-screen keyboard on both iOS and Android.

**Touch.** Under `(pointer: coarse)` the hover-only affordances — session row
actions, and anything else that appears on hover — become permanently visible,
and hit areas grow to 32–44px. A control the user cannot see or cannot hit is
not a degraded experience, it is a missing one.

**Tab reordering** is implemented once with Pointer Events rather than HTML5
drag-and-drop, which never fires on touch. A mouse starts dragging after ~8px of
horizontal movement; a finger needs a ~320ms long press, because an immediate
drag would steal the horizontal swipe that scrolls the tab strip. `touch-action:
pan-x` on the strip and `none` on the tab being dragged keep the two gestures
from fighting.

**Compact specifics.**

* The sidebar is a drawer over the content with a scrim; choosing a file or a
  session dismisses it, as a native drawer would.
* Its toggle moves into the tab bar, next to what it reveals, rather than being
  duplicated in the title bar.
* Dialogs dock to the bottom as sheets with a grip, sized to `88dvh`.
* The settings drawer switches from the right edge to the bottom, and its
  section nav becomes a horizontal scroller.
* The comment composer docks to the bottom instead of floating at the caret,
  where it would collide with the native selection handles and the keyboard.
* Title-bar metadata (model, extension status) is dropped; the model lives under
  the composer anyway.

**Installability.** A web manifest, maskable icon, `standalone` display, and
scheme-aware `theme-color` so the status bar matches the app in both themes.

---

## 48. Global settings

Some configuration should not be repeated in every workspace file.
`~/.picone/settings.json` (under `PICONE_DATA_DIR`) holds it:

```json
{
  "mcpServers": {
    "github": { "command": "github-mcp", "enabled": true }
  },
  "skills": ["~/work/skills"],
  "disabledExtensions": ["rpiv-todo"]
}
```

**What needs this, and what does not.** Pi already discovers global skills,
extensions, and prompt templates from `~/.pi/agent` and `~/.agents`. Those work
in Picone with no configuration — this file is for the gaps:

* **MCP** — Pi has no MCP of its own (§32), so without a global list every
  workspace file would repeat the same servers. Global servers merge with the
  workspace's, and the workspace wins on a name collision, including setting
  `enabled: false` to switch a global server off for that project. MCP state
  reports which side a server came from. Changes restart the servers at once.
* **Extra skill directories** — added to Pi's own discovery, for every
  workspace.
* **Disabled extensions** — Picone filters them out of the resource loader by
  name. It never edits Pi's settings: installing and removing packages belongs
  to `pi install`, and quietly rewriting the CLI's config would be the wrong
  kind of helpful. Takes effect in sessions created afterwards.

Both `mcp` and `mcpServers` are accepted as the key, so a config can be pasted
across from Claude Desktop or Cursor without renaming anything.

The Global section of the settings drawer edits all of this, and lists what Pi
actually loaded — extensions with their resolved paths, plus skill and prompt
counts. That listing exists because otherwise there is no way to see, from the
browser, what the agent has been given.
