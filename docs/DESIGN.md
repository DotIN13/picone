# Picone — Architecture & Design

A browser-native coding agent powered by Pi.

This document describes the system as designed **and built**. Section numbers
`§1`–`§41` are referenced from comments throughout the source, so they are
stable; where the implementation diverged from the original plan, the section
says so rather than being renumbered. Sections `§42`–`§50` cover subsystems that
were added during the build.

Known gaps live in [todo/](todo/).

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

  "skillPaths": ["~/work/skills"],
  "skills": { "troubleshooting": { "enabled": false } },

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

**A workspace opens one working directory, any number of context directories,
and any number of memory directories.** The three differ in role, not in kind:
`cwd` is where the agent works and where a shell command starts; `context` is
open beside it and equally writable — another repository, a spec folder, the
subdirectory you are actually living in this week; `memory` is the readable
store of §50. The older flat `directories` list is still read, its first entry
as the cwd and the rest as context, which is what it already meant in practice
since the runtime picked the first existing entry to work in. Nothing needs
rewriting to open.

**One funnel sets the open workspace.** The loader cannot fill `memory` — it
cannot see the global list a workspace's entries merge with — so the app does,
and every path that produces a `Workspace` has to go through that step. Saying
so in a comment was not enough: changing the model rewrites the workspace file
to record the new default, and that path assigned the loader's result straight
to `this.workspace`. Every memory directory then vanished from the settings
panel and the file tree until the workspace was reopened, while the global panel
went on listing them, because it reads the settings rather than the merge. The
assignment is a single private method now, and resolving is part of it.

**They may nest, and that is often the point.** Deduplication is by exact path,
so naming `…/picone/docs` while the cwd is `…/dotty-projects` opens both: one is
the tree you navigate, the other is a shortcut to the part of it you care about.
The sidebar lists the cwd first, then context, then memory — a fixed order,
because the cwd is where the projects are and burying it among reference and
memory directories is what made them hard to find. Context and memory roots
carry a tag; the cwd does not need one, being the first row.

**The agent is told the paths and nothing else.** A directory listing is
discoverable with the tools it already has, and a summary written at session
start is stale by the second turn — so the workspace description is a working
directory, a list of the rest, one line saying that nesting is deliberate, and
the workspace's own instructions. Memory directories are deliberately absent
from it: they are readable roots, but listing them beside project code sends the
agent looking for source files in them, so they get their own context file
(§50).

**A workspace can be created from any directory.** Requiring a hand-written JSON
file before anything could be opened made the product unusable on first run.
`POST /api/workspace/create` takes a directory, writes
`<name>.workspace.json` into it with `cwd: "."` — so the file travels
with the checkout — and opens the result. The alternative location, Picone's own
data directory, exists for projects that should not carry a Picone file.

**The picker is one path field plus a listing**, and the pair is a component
of its own (`PathBrowser`) because finding a folder is not only how a workspace
is opened.

Above it sits `DirectoryDialog`: the browser, the line naming the folder that
will be committed, and the confirm button. Everywhere Picone asks for a
directory asks the same question, and the answer used to be typed by hand in the
one place that mattered most — a settings field holding a raw path asks the user
to be their own file manager. What differs between callers is only the ending,
so that is all a caller supplies: memory (§50) adds a name and a writable
switch, the workspace's own directory fields add nothing.

The workspace picker keeps using `PathBrowser` directly rather than the dialog,
because choosing a workspace *file* — or creating one in a folder — is a
different question with a different answer, and a folder chooser would fit
neither ending.

The listing is the completion surface and it always shows a *real folder*: the deepest one on the typed path
that exists, named above the rows so the field and the listing can never quietly
disagree. Typing after the last separator filters it; a name matching nothing
falls back to the whole folder, because a name that matches nothing is usually a
name being invented, and blanking the panel at that moment is the least helpful
thing the UI could do. A folder that does not exist resolves to its nearest
ancestor, with a line saying so, rather than to an empty box.

**One cursor covers the whole listing, `..` included**, at index -1. Sharing it
is what keeps `..` from lighting up alongside a row rather than instead of it,
and lets the arrow keys, Tab and Enter reach it like any other candidate.

**Enter goes where the eye already is** — into the highlighted folder, or into
the highlighted workspace file. The exception is something typed out in full: an
existing file opens and a new workspace name is created, both ahead of the
highlight, because when a name is being invented the fallback listing highlights
a row that has nothing to do with it.

**Tab completes.** It accepts the highlighted candidate: a folder becomes the
new location and the listing follows it in, a filename is filled in whole.
Pressing it again walks the candidates — captured on the first press, because
filling one in narrows the field's own filter down to it. Shift+Tab steps back
out, so completing forward is never a one-way trip into the first child of every
folder. Touch devices get a `Tab` button in the field, since the key they are
missing is the whole accelerator; it is hidden by `(pointer: coarse)` rather
than by a condition in the component, being the same responsive decision the
rest of the layout makes in CSS.

**Create takes either.** With a folder on screen it writes
`<slug>.workspace.json` inside it. Type a workspace filename that does not exist
yet — `picone1.workspace.json` — and Create writes exactly that, with the name
derived from the filename and Enter bound to it. Only names Picone would
recognise count, so a half-typed prefix stays a completion instead of becoming
an offer to create something.

Clicking a folder descends, clicking a workspace file opens it. Recent
workspaces sit underneath and hide while filtering. Non-workspace files are
listed for orientation but are not clickable — offering `package.json` and then
failing validation would be a lie.

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
  /** Extra directories to load skills from, on top of Pi's own discovery. */
  skillPaths?: string[]
  /** One entry per discovered resource, keyed by name (§35). */
  skills?: Record<string, { enabled?: boolean }>
  prompts?: Record<string, { enabled?: boolean }>
  extensions?: Record<string, { enabled?: boolean }>
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

`skills` used to be the array of extra skill directories. An array there is
still read — as `skillPaths`, with a deprecation warning in the diagnostics —
so an older workspace file keeps working.

Paths accept `~` and resolve relative entries against the workspace file's own
directory, so a workspace can sit inside the repository it describes.

A directory that does not exist is a diagnostic, not a failure — a shared
workspace file still opens on another machine.

---

## 5. Filesystem model

No mount aliases, no virtual filesystem. The workspace names directories and Pi
uses ordinary absolute paths.

Roots come in two kinds. `directory` roots are the project — writable, and the
first existing one is the process cwd. `memory` roots (§50) are folders of
long-lived notes: readable everywhere a project file is readable, listed in the
tree with a tag, never the cwd, and writable only if their entry says so.

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

## 8. The agent adapter

A session is a shell around an agent. The shell — `agents/session.ts`, still
called `SessionRuntime` — owns everything that is Picone's rather than any
agent's: the transcript and its rows in the database, the permission gate, the
title, and what a message picks up on its way past (§16, §52). The agent owns
the conversation: history, context, compaction, tool execution.

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
  updateWorkspace(workspace): void

  snapshot(): AgentEvent
  commands(): SlashCommand[]
  capabilities: AgentCapabilities
  dispose(): void
}
```

`displayText` exists because the model-facing text and the transcript text
differ for structured input — a file comment is a long structured block to the
model and a compact card to the human.

Between the two is `agents/backend.ts`: `AgentBackend` for what an agent must
do, `AgentHost` for what it may call back into. Two backends implement it, Pi
(§41) and Claude (§58), and the shell knows nothing about either — which is the
only real test of how thin §41's claim was. It was thinner than expected in the
places that matter and thicker in one: the *transcript* turned out to be shared
and the *stream* to be specific, so `agents/translator.ts` holds the rules for
assembling a conversation and each backend only reads its own agent's events
into it. Those rules — flush the assistant's text before a tool call so the
transcript reads in the order things happened, commit a message only if it said
something — took a while to get right and are not agent-specific.

**Capabilities travel with a session.** Agents differ: Pi can rewind to a
message in place and draw an extension's own interface, Claude can restore the
*files* at a message and has no extensions at all. Rather than each surface
knowing which agent supports what, every session carries an `AgentCapabilities`
and the browser draws only what exists. A rewind button that answers "not
supported for this session" is worse than no rewind button.

The frontend never sees a Pi type or an SDK type. Everything crosses the
boundary as the protocol in §30.

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

### Location, before category

A category alone cannot express "may write here but not there", and `files:
allow` used to mean the agent could write **anywhere on the disk** — which is
not what anyone setting it assumes. So classification also reports *the paths a
call would modify*, and the gate checks them first:

```text
write / edit / multiedit → the paths in the arguments
read / ls / grep / find  → none
bash and friends         → none
```

A write whose target lies outside every writable root is refused before the
category is consulted, so `allow` cannot grant it. Writable roots are the
workspace directories plus any memory directory marked writable. The refusal
names the path and lists where writing *is* allowed, so the agent can correct
itself rather than retry.

Three deliberate limits:

* **Reads are not location-checked.** Reading widely is useful, the workspace
  picker roams the disk already, and confining reads would break more than it
  protects.
* **Shell is not location-checked.** A `bash` line can write anywhere and
  finding out would mean parsing shell, which is a losing game. Shell stays
  governed by its own category, `ask` by default — which is the real reason that
  default is not `allow`.
* **One forbidden target refuses the whole call.** A `multiedit` spanning an
  allowed and a forbidden path is denied entire; half-applying it would be
  worse than refusing it.

Relative paths resolve against the session's cwd, the same way the tool itself
would resolve them, so `../../escape.txt` is caught rather than mistaken for a
path under the server's own working directory.

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
│ ▣ Acme ▾  Working           probe status  2 MCP  ☀ ⚙             │
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

**One status pill, not a pill and a light.** It reads `Idle`, `Working`,
`Waiting for you`, or `Offline`, and the connection is part of it rather than a
coloured dot in the far corner — two status displays in two vocabularies, and
the one in the corner needed a tooltip to say what it meant.

It is **the same muted pill in every state**: one word, a hairline, no colour
and nothing moving. The pill reports, it does not raise an alarm. Urgency
belongs to the permission card and the error toast, which appear in the
transcript where the work is; a title bar that pulses at you all run is a title
bar you stop reading.

Thinking, writing and running a tool collapse into *working*: they are all the
agent being busy and the transcript already says which. Waiting on a permission
stays its own state, because the agent has stopped and it is the human's move.
`Offline` outranks everything, since whatever the session was last doing, what
is on screen is a snapshot from before the socket dropped.

**The boundary between them is draggable.** The sidebar is 264px by design,
180 to 640 by hand, and the handle between it and the main pane is a real
`role="separator"`: pointer events so a trackpad, a pen and a finger take one
code path, pointer capture so a fast drag that outruns the cursor keeps
resizing, arrow keys because a control only a mouse can reach is not a control,
and double-click (or `Home`) back to the design width — a pane dragged to
nothing is otherwise hard to recover.

The handle is 1px of visible hairline with a `::after` widening the hit target
to ±3px, or ±8px on a coarse pointer: thin enough to read as a seam, wide enough
to grab. The width is an app setting (§49), so it persists per browser rather
than travelling in the workspace file.

The one subtlety is that the drag delta arrives in **physical** pixels while the
width it sets is CSS pixels, and interface scale is a `zoom` — at 140% an
uncorrected handle slides out from under the cursor by 40%. The delta is divided
by the element's `currentCSSZoom`, sampled once at pointer-down.

Only beside a real column: at compact widths the sidebar is an overlay floating
over the work, and there is no boundary to move.

The same two primitives rearrange for small screens rather than being replaced —
see §47.

---

## 12. File browser sidebar

Each configured directory is a root node, in the order of §3: the working
directory, then context, then memory. The tree lazy-loads one level at a time;
nothing recurses on startup.

**Open and closed belongs to the row, not the directory.** Roots nest (§3), so
a context directory is both a root of its own and a child of the working
directory it sits inside — the same folder in two places. Keyed by path, those
two were one switch: opening either opened both, which made the tree look like
it was opening folders by itself. The key is the root a row is shown under plus
its path, encoded as JSON because every character a separator might use is one a
path is allowed to contain. Directory *contents* stay keyed by path alone: what
is inside a folder is the same wherever you look at it, and only whether you are
looking is local.

**Nothing opens itself.** The tree comes up as the list of roots and waits.
Auto-expanding every root, then only the working directory, were the same
mistake at different sizes: a refresh cannot restore where you were, and a guess
at which folder was wanted reads as the tree acting on its own. Closed is the
honest resting state. The working directory's listing is fetched anyway, so the
first click on it is instant — a prefetch, not a decision about what to show.

Revealing a path (§51) picks the *most specific* root containing it, so a file
under a context directory appears beneath that directory rather than at the end
of a long chain under the cwd.

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

**A vertical wheel scrolls the tab strip sideways.** Its scrollbar is hidden and
a mouse has no horizontal axis, so without translating the wheel the only ways
to reach an off-screen tab are a trackpad swipe or shift-wheel, and neither is
discoverable. The strip animates its own programmatic scrolls — it slides the
active tab into view when that changes from elsewhere — but wheel scrolling is
instant, because animating every tick lags behind the hand.

---

## 14. Chat surface

A session tab shows user messages, assistant messages, thinking (collapsed),
tool calls, permission requests, extension output, and notices.

**Tool calls are lines, not cards.** A turn can make a dozen of them, and boxing
each one turns the transcript into a wall of containers with the conversation
lost between them. So each is a single row — a status glyph, the tool, a
one-line summary of its arguments — expanding to output, or to a coloured
unified diff when the tool returned a patch. The output hangs off the row under
a left rule rather than in a panel of its own.

Success is deliberately the quietest state, a grey dot: what wants finding in a
long run is the one call that failed, so only failures take a colour. File-shaped
calls offer **Open**, which appears on hover and opens a tab without navigating
away from the conversation.

**The view follows the bottom and lets go the instant you scroll up.** It takes
up again when you move back *down* to within 120px of the bottom, or when you
send from within that same distance — sending from halfway up a long transcript
leaves you where you were reading. What it never does is re-attach on its own:
every way back requires a deliberate move downwards.

One threshold for both, and a generous one, because they are the same
judgement: near enough that you meant to be following. Re-attaching only on a
perfect landing means chasing a target that is still moving while an answer
streams in; the *direction* is what carries the meaning, and downwards is
unambiguous.

Coming back down is detected **once a frame, not from the `scroll` event**. A
scroll event is dispatched at the end of the frame, and mid-turn the transcript
has grown underneath it by then: a scroll that landed exactly on the bottom
measured ~100px above it by the time the handler ran, so a threshold tight
enough to mean "at the bottom" never matched. A frame is the shortest interval
available, so what it measures is barely stale. While nothing is streaming
there is no growth, and the scroll handler does it.

Following takes two mechanisms because neither is enough alone. Watching the
number of items only fires when a message is *added*, and a streaming message
does not change the count, so the view stopped following the moment an answer
began. A resize observer is the obvious replacement and is too coarse on its
own: during a fast stream it delivered two callbacks for an entire turn while
the bottom drifted 140px away. So a frame loop runs while the agent is working,
and the observer covers everything else — an image finishing, a tool call
expanding, the window changing shape.

**Letting go is driven by the gesture, not by the scroll event**, and that is
forced by the frame loop: it writes `scrollTop` every frame, so a wheel tick
would be undone before the `scroll` event it produced had been handled and the
view would refuse to move at all. Wheel, touch drag and the arrow/page/home keys
each release directly. A scrollbar drag produces none of those, so `scroll` is
kept as a backstop — but only when the view also moved *off* the bottom, because
content shrinking mid-turn makes the browser clamp `scrollTop` down by itself,
and reading that as a gesture unpinned the view in the middle of its own answer.

**Snapshots are reconciled by id, not assigned.** A `session.snapshot` arrives
with fresh objects and `<For>` keys on reference, so assigning it rebuilt every
row and re-parsed every markdown message with it. Measured on a 153-row
transcript, one short turn tore down 152 rows and built 154 — because a snapshot
is emitted mid-turn (§53). Reconciling by `id` took the same turn to 2 nodes
added and none removed.

**And nothing between the store and `<For>` may re-wrap the items.** Reconciling
the store is only half of it: the list handed to `<For>` has to be the store's
own objects. Two things quietly broke that. The timestamp separators were built
by mapping the items into `{item, stamp}` pairs, which are new objects on every
recompute — so every row was rebuilt on every streamed delta, several times a
second, despite the reconcile. And an update merged by `upsert` replaced the
item at its index, which is a new reference for exactly the row that is
changing. Both are invisible until something inside a row holds state, and then
they are very visible: an expanded tool call collapsed itself while the tool was
still running. The stamp is computed per row from the index instead, and
`upsertItem` merges changed fields into the existing object.

A row is state, in other words, not just output — the identity of the object it
is keyed on is a contract with anything inside it.

**Only the tail of a long transcript is in the DOM.** 60 items are rendered from
the end; scrolling towards the top of what is rendered pulls in another page and
holds the reader's position, and returning to the bottom throws the extra away,
so a session open all day costs what a fresh one does. On a 155-row transcript
that is 1 696 nodes instead of 2 759, and the trim is invisible because it only
runs while following the bottom, where the dropped rows are screens away.

**Windowed from the tail, not around the viewport.** A true virtual list has to
guess the height of what it is not showing, and every guess lands on the
scrollbar; growing downwards from a fixed end needs no estimates, no spacers and
no jitter. The price is that far-back history takes a moment of scrolling rather
than a drag of the scrollbar — and a count of what is not shown, which doubles
as the control that shows it.

`content-visibility: auto` was the other candidate and was measured and
rejected: layout is already cheap (0.3ms for a full pass over 155 rows), and it
collapsed `scrollHeight` from 36 187 to 19 605 as unmeasured rows fall back to
their intrinsic-size estimate — which breaks both the scrollbar and sticking to
the bottom.

**The transcript is paged out of SQLite too**, so opening a session no longer
reads all of it. The runtime holds the last 120 rows and the browser renders 60
of those; scrolling back widens the window first, because those messages are
already here, and only then asks the server — `GET /sessions/:id/messages`,
cursored on a *message id* rather than a row number so the browser never learns
how the transcript is stored. An id that no longer exists (rewound away) answers
"nothing before this" rather than failing.

Holding only the tail costs two assumptions that used to be free. A row's `seq`
was its index in the array, and is now `baseSeq + index` with `baseSeq` the seq
of the first row held — the next free number is read from the table rather than
counted. And `syncEntryIds` (§53) paired Pi's branch with the transcript from
the *start*; the two now share a suffix rather than a prefix, so it walks
backwards from the end, which is the more robust direction anyway.

A snapshot carries only the tail, so the browser keeps any older pages it has
already fetched in front of it instead of discarding them — a snapshot arrives
mid-turn, and losing the history you just scrolled back to read would be worse
than never having fetched it.

**Time is marked when the conversation resumed, not on every message.** A stamp
per line is a column nobody reads. One appears after half an hour of silence,
one when the day changes, and one at the top of the rendered window — which with
a windowed transcript is an arbitrary point in history and ought to say when it
is. Today shows a bare time, yesterday and older carry the date.

**The working indicator sits in a slot that keeps its height.** It used to be a
row in its own right, so finishing a turn removed it and slid the whole
transcript down by its height plus the gap — a jump at the exact moment the
reader starts reading the answer.

**Send outranks stop.** While the agent runs an empty composer offers **Stop**,
but the moment something is typed the button becomes **Send**: that text is
steering (§28), and making someone clear the box to reach a send button — or
press Enter on a control labelled "stop" — is the wrong way round. Emptying the
field brings Stop back.

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
streaming session is never evicted. The loaded set is a *cache*, so anything
that lists sessions reads the table and overlays the live ones — a list built
from the loaded set silently loses rows the longer the app stays open.

**Names are shared with Pi, in both directions.** Pi has a session name and
never invents one: `setSessionName` is all it offers, and Pi's own interface
falls back to showing your first message. Picone keeps its own title, so the two
are kept in step — renaming here calls `setSessionName`, so the name lands in
the session file and is there for `/name` in a terminal; and a session adopts
the file's name when it loads, or pushes its own if the file has none.

The file wins when it has an opinion, because it is the shared artifact: Pi can
be pointed at the same session from a terminal between runs, and whatever it was
called there is what the session is called. Pi also sanitizes — newlines become
spaces, and it is trimmed — so the stored title is read back from Pi rather than
kept as typed, and the two cannot drift apart on a technicality.

Nothing generates a title. Every session is still called "New session" until
somebody names it; see [todo/session-titles.md](todo/session-titles.md).

---

## 27. Sidebar sections

The sidebar has two modes, **Files** and **Sessions**, plus always-visible
comment and MCP sections beneath the tree. Both modes open with the same filter
box — a heading that says "Sessions" above a list of sessions is a line of
furniture, and the list is the thing people arrive wanting to search.

A session row answers *which conversation was this?*: the name, up to two lines
of the most recent message, how long ago it moved, a `fork` tag when it came
from one (§53), and a spinner while it is running. It renames, deletes, and
opens sessions as tabs.

The **model is deliberately not there**. It is the same for nearly every
session, it changes under you, and it is already on the composer where it can
also be changed — three reasons for a column that never distinguishes one row
from another.

The excerpt is the newest thing anybody actually **said** — user or assistant,
and nothing else. A transcript ends in machinery far more often than in
conversation (a model switch, a rewind notice, an API error, a tool call), and a
column of rows reading "Model switched to …" says nothing about which
conversation each one was. Between the two it is simply the newest: what a
session is about right now is usually the answer, not the question. A session
where nothing was ever said shows no excerpt at all.

It is read straight from the transcript table, narrowed in SQL and confirmed by
parsing — a message whose own text contains `"kind":"user"` would match the
pattern, and a coding transcript is exactly where that happens. Filtering matches the name *and* the excerpt, since
a conversation is often remembered by what was said in it rather than by what
it was called.

Times are relative — "2m ago", "3d ago", then a date. A column of full
timestamps is near-identical text, and what a reader wants from a list is which
one is recent.

**The time, and the order, are the last message — not the last click.** Ordering
by "updated at" put whichever session you opened at the top, so the list
reshuffled itself as you read it and a conversation you were halfway through
sank the moment you glanced at another. Both now come from the same message the
excerpt does, so a row's text and its time always describe one moment. A session
where nothing has been said sorts by when it was created, which keeps a new
empty session at the top where it was just made.

Which session **reopens** with the workspace is a different question, and still
answered by the last one *opened*: you come back to where you were, even if a
background run has said more somewhere else since.

The list is republished whenever a transcript grows, coalesced into one update
per 400ms — a busy turn commits a tool call at a time, and rebuilding costs a
query per session. Without it the excerpt and the ordering were correct only
until the next message and then quietly wrong until something else refreshed
them.

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

**A transcript is pushed, so the client has to notice when it was not.** Three
paths deliver a snapshot — connecting, activating a session, and selecting one —
and reopening a workspace fell through all of them: the server activates the
session *during* the request whose response then clears the client, so the
snapshot arrived before there was anywhere to put it and the chat stayed blank
until something else happened to refresh it. Selecting a session that is already
active used to return early for the same reason it looks redundant, which meant
clicking the blank session did not fix it either.

Two rules now. Selecting a session always sends its snapshot, whether or not
anything changed — the caller is a browser asking to see it, not a request to
mutate state. And after any state refresh the client asks for the transcript of
a session it is showing but has never been sent: a missing key means never
received, where `[]` means received and empty.

**The client re-reads everything on every connect, not only the first.** The
socket coming up is the one reliable signal that a server exists, and it is not
only a network blip that brings it down: `tsx watch` restarts the server on
every edit, and at startup Vite serves the page before the API is listening.
Treating the first fetch as the only one left the app holding whatever it
managed to get before the drop, or nothing at all, until a manual reload. The
resync collapses overlapping calls, so starting up and reconnecting at the same
moment asks once.

In development Vite also waits for the API before it starts
(`scripts/wait-for-api.mjs`), so the first page served has a server behind it
rather than a screenful of proxy errors. What remains is filtered by a custom
logger in `vite.config.ts`: a proxied websocket losing its far end — a tab
closing, a reload, the API restarting, and the client's own retries while it is
down — is normal and reported as a stack trace, which at a glance is
indistinguishable from a real fault. Only the websocket path is filtered, and
only for a hangup; an `/api` request failing is not retried in a loop, so it
still comes through with its URL.

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
disabled, tool count — is visible in the sidebar.

MCP has **no settings UI**: because it is Picone's own addition rather than
something Pi understands, it is configured by hand in the workspace JSON or in
`~/.picone/settings.json` (§48) until it earns a place in the drawer.

MCP tools go through the permission gate like anything else: one with a
`command` argument is a shell request (§9).

---

## 33. Skills

Pi *already* discovers skills from `~/.pi/agent/skills` and `~/.agents/skills`,
along with extensions and prompt templates — nothing is needed from Picone for
those to work. Pi owns how they enter context and execute; there is no parallel
context-management system around them.

Two things sit on top of that discovery, and only those two:

* **Extra directories** — the workspace JSON's `skillPaths` and the global
  `skillPaths` list (§48) are handed to the resource loader as additional skill
  paths. Both are edited in the JSON, not in the UI.
* **A switch per skill** — the `skills` record in the workspace file, which is
  what the Skills section of the settings drawer edits (§35).

---

## 34. Workspace updates

Editing configuration through the UI writes `workspace.json` and reloads it. A
running session is **not** told.

What applies live applies live: permissions and the writable roots are refreshed
on every open session, MCP servers restart, and a model change applies to the
session that made it (§45). Everything else — the workspace description, skills,
prompt templates, extensions, memory stores' instructions — is read when a
session is built, so it takes effect on the next reload.

**Announcing the rest was tried and taken back out.** Telling the agent at the
moment of the edit meant calling `prompt()` with the description, which starts a
turn: switching a permission woke the agent to acknowledge a setting nobody had
asked it about. Deferring it to the next message avoided that, but the message
is a *diff*, and keeping one honest means keeping a record of what each session
has heard, resolving the halves of the config that merge with the global
settings, and reconciling with compaction — which rewrites the transcript the
diff was delivered into while leaving the system prompt untouched. Each piece
was reasonable; together they were a lot of machinery for something a reload
already does correctly. Pi rebuilds the whole prompt when a session is built, so
reopening is the honest way to pick up a change, and it is the one path that
cannot drift.

---

## 35. Workspace settings

A side drawer with sections: General, Directories, Skills, Prompts, Extensions,
Permissions, Voice, Model. Every edit writes back to `workspace.json`, which
stays the source of truth. **Open workspace JSON** opens the file itself as a
read-only tab.

**Edits save themselves.** There was a draft and a Save button, and the button
is what people miss — adding a directory through the folder chooser reads as an
action that *happened*, because it happened in a dialog with its own confirm,
but it only touched a draft that closing the drawer threw away. The app settings
next to it had always applied instantly. Writes are coalesced on a 400ms timer,
because a text field patches on every keystroke and each save rewrites the file
and reloads the workspace behind it; the draft survives only as that one
keystroke of slack, and a rejected edit stays in it to be corrected rather than
silently reverting. The footer says where the writing went, since the file
travels with the project and it should not be a surprise that one was touched.

Load diagnostics — missing directories, missing skill paths, problems in
`~/.picone/settings.json` — surface in General.

**Skills, Prompts and Extensions are lists of switches, and nothing else.**
Picone does not create resources: skills and prompt templates are files under
`~/.pi/agent` or `~/.agents`, extensions are installed with `pi install`, and
new ones can be written from a session. So there is no add button here. What the
workspace file records is only which of the discovered resources this workspace
wants — one object per item, keyed by the name Pi knows it under:

```json
"skills":     { "troubleshooting": { "enabled": false } },
"prompts":    { "review-loop": { "enabled": true } },
"extensions": { "rpiv-todo": { "enabled": false } }
```

The same shape as `mcp`, and an object rather than a bare name so an entry has
somewhere to grow. **A name that is absent is enabled**, so a skill installed
tomorrow is available to today's workspace without editing the file first — the
file records decisions, not an inventory of the machine. An entry that only says
`enabled: true` is kept once written: it is a decision the user made.

The server enforces this through the resource loader's `extensionsOverride`,
`skillsOverride`, and `promptsOverride` hooks, capturing the full list before
filtering — a disabled resource has to stay visible, or there would be no switch
to turn it back on. Pi's own configuration is never touched: the CLI still sees
everything the user installed.

Resources are read when a session is built, so a change applies to sessions
started afterwards, and the drawer says so. The switches therefore read from the
workspace file rather than from what the running session loaded, which would
make a saved change appear to revert.

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
Permissions              files/shell/git · allow/ask/deny · cards · path writes
File comments            selection · matcher · composer · inline display
Comment → session        steer when active, otherwise next input
File watching            open tabs only · refresh banner
MCP and skills           from workspace JSON, scoped to the workspace
Memory directories       global and per-workspace · read-only enforcement  §50
Voice                    dictation and the speak tool
Slash commands           §43
Extension UI             §44
Model selection          §45
App settings             theme · fonts · two size controls · notifications  §49
Resizable sidebar        dragged, keyboard-reachable, persisted            §11
Media and references     images · diagrams · path and URL pills            §51
Memory mentions          `@` a subject; the agent gets a pointer, not a page  §52
Rewind and fork          go back to a message, in place or in a new session §53
```

Tests cover the pure pieces of §51 — the reference detector, fence completion
and streaming prefixes. Everything else is still verified by driving the running
app; see [todo/automated-tests.md](todo/automated-tests.md).

Remaining work is in [todo/](todo/): thin test coverage, a single large web
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

**Stacking order is named, in `base.css`, and nowhere else.** The distinction
that matters is between a *surface* — something you open and work inside, like a
dialog or the settings drawer — and a *floating* layer anchored to a control,
like a select's listbox. A floating layer must clear every surface, because a
select inside a drawer has to draw over that drawer to be usable. Two loose
numbers in two files got this backwards once: `select-content` sat at 95 under a
drawer at 101, so every dropdown in settings opened *behind* the panel and the
click landed on the drawer. Hence `--z-inline`, `--z-overlay`, `--z-dialog`,
`--z-drawer`, `--z-floating`, `--z-tooltip`, `--z-toast`, all in one block.

**Never name a component after a Solid control-flow primitive.** `Show`,
`Switch`, `Match`, `For`, `Index`, `Dynamic`, `Portal` are compiled specially by
the JSX transform, so a local `function Switch()` is read as *the* `Switch` and
its children are expected to be `Match` elements. A status glyph called `Switch`
crashed on `mp.when` the moment a tool call rendered, which took the whole
transcript down with it — and only in the dev build, so a production build had
been passing all along. Verify in `npm run dev`, not only against `vite build`.

---

## 43. Slash commands

Typing `/` opens a filtered menu. Arrow keys choose, Tab completes, Enter sends,
Escape dismisses.

Two sources:

* **Pi commands** — prompt templates, skills, and extension commands, read from
  `pi.getCommands()` on the extension API and pushed per session, because
  extensions and skills differ between sessions. Picone only completes the
  token; Pi expands templates and executes extension commands itself.
* **App commands** — handled in the browser and never sent to the model:
  `/new`, `/close`, `/settings`, `/theme`, `/sidebar`, `/compact`, `/reload`,
  `/stats`, `/export`.

Each entry shows its source, so it is clear what will happen.

The last three exist because Pi's own equivalents are TUI commands with no
route through the extension API — but the *capability* is on `AgentSession`, so
Picone offers its own command over the same call. `/reload` re-reads the
resources and rebuilds the system prompt (§34), which is how a running session
picks up a settings change. `/stats` reports Pi's tally — messages, tokens,
cost — aggregated over the whole session file including history compaction has
dropped, so it is what was billed rather than what the transcript still shows.
`/export` writes the session out as HTML through Pi's own exporter, into Pi's
session directory: it owns the file being rendered, and a second renderer here
would drift from it.

All three answer as transcript notices rather than as messages. They are
answers to a question the human asked, and no business of the agent's.

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

* **A component-factory widget is not TUI-shaped, and assuming it was cost us a
  whole extension's display.** `setWidget` takes either an array of strings or a
  factory, `(tui, theme) => { render(width): string[] }`. RPC mode drops the
  factory and so did we — reasoning, wrongly, that a component is a terminal
  thing. But that signature asks for a width and returns lines; the terminal is
  merely the caller that usually asks. The `rpiv-todo` extension renders its
  entire list this way, so todos worked in Pi's TUI and were invisible in
  Picone, with no error anywhere to say why. We call the factory now, with a
  plain-text theme in place of the ANSI one, and forward the lines to the same
  place the array form goes. Extensions register once and then call
  `tui.requestRender()` when their data changes, so the component is kept and
  re-rendered on request.

  Two judgements inside that. The theme styles *nothing* rather than emitting
  ANSI for the browser to strip — colour is CSS's job, and a half-stripped
  escape in a `<pre>` is worse than no colour; the glyphs (`○ ◐ ✓`) carry the
  meaning anyway. And the width is a generous 160 rather than an accurate
  guess, because extensions use it to truncate rather than to pad: too wide
  only means nothing is cut and the browser wraps, while too narrow would lose
  text before it was ever sent.

* **`ui.custom` is a screen, not a question, and it runs where it already is.**
  An extension hands over a component that renders lines and consumes
  keystrokes until it calls `done` — `pi-subagents` builds a whole chain editor
  this way. The component stays on the server; only its lines and your
  keystrokes cross the wire, which is all a terminal was doing for it. The
  browser translates a `KeyboardEvent` into the bytes a terminal would have
  sent, because the browser is the only place that has the event.

  It settles exactly once, by one of three routes: the component calls `done`,
  you dismiss the dialog, or the session ends. That matters more than the
  rendering — an extension awaiting `ui.custom` must never be left waiting, and
  the old behaviour of returning `undefined` immediately was at least honest
  about not supporting it. Escape is deliberately *not* intercepted: a text UI
  reads it as "back one level", and stealing it would make the outermost level
  unreachable.

Still not supported: raw terminal input (`onTerminalInput`), replacing the
editor with a component that reads it, and custom autocomplete providers. The
first two need a terminal specifically.

### The surface, in full

The mapping is not obvious from Pi's types alone, so it is written out. Four
methods block until the human answers:

| method | request fields | response |
|---|---|---|
| `select` | `title`, `options[]`, `timeout?` | `{ value }` or `{ cancelled }` |
| `confirm` | `title`, `message`, `timeout?` | `{ confirmed }` |
| `input` | `title`, `placeholder?`, `timeout?` | `{ value }` or `{ cancelled }` |
| `editor` | `title`, `prefill?` | `{ value }` or `{ cancelled }` |

Five are fire-and-forget:

| method | web mapping |
|---|---|
| `notify` | chat notice, at info / warn / error |
| `setStatus` | pill in the title bar; `undefined` clears it |
| `setWidget` | monospace block above or below the composer |
| `setTitle` | session tab label |
| `setEditorText` / `pasteToEditor` | composer contents |

Pi's reference implementation is `dist/modes/rpc/rpc-mode.js`; the TUI client
equivalent is `examples/rpc-extension-ui.ts`. To exercise all of it, drop an
extension in `.pi/extensions/` registering one command per method — that is how
this was verified.

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

**One chain, three inputs.** Every painted size in the app is
`px x --font-scale x --ui-scale` for text and `px x --ui-scale` for geometry.
Three things feed that, each set in exactly one place: `--ui-scale` is the
Interface size setting, applied as `zoom`; `--content-font-scale` is the Font
size setting, folded in on the content panes only, so prose grows without the
chrome moving; and `--text-boost` is 1 everywhere but the phone. Rules never
read the three — they write `calc(Npx * var(--font-scale))` and let the chain
resolve. The full statement lives at `:root` in `base.css`.

**The baseline is 125% of the design, everywhere.** The design turned out to be
drawn a notch small — on a monitor as much as on a handset — and the fix that
does not mean restating every number in every stylesheet is to move the
baseline: `BASE_ZOOM` is 1.25, the Interface size setting multiplies it, and
what used to require choosing 125% is what 100% gives. Existing browsers are
migrated by the reciprocal on load, so nothing anyone is looking at changes
size; only the number describing it does. The preset list is re-based with it,
0.8 landing on the old 100%.

**A phone's text is larger still.** The design is drawn for a pointer at desk
distance; the same numbers on a handset held closer, and tapped rather than
clicked, come out small. The baseline covers the geometry now — a phone no
longer starts at its own scale, which would stack with it and overshoot — but
`--text-boost` still puts the 13px body text on 16px, and *only* the text: a handset needs larger type than a monitor but not
proportionally larger buttons, and 16px of text wants a 39px send button rather
than a 48px one. Zoom alone cannot express that, which is the whole reason the
second lever exists.

Sixteen is not an arbitrary landing point. It is the size below which iOS zooms
the page when you focus an input, so putting the base there means the composer
clears the threshold without being special-cased — and because the boost is a
multiplier and not a size, the Font size setting still does what it says on a
phone: 16px chosen in settings is 16/13 *on top of* the boost, and the transcript
grows past the chrome exactly as it does on a desktop.

**The composer is a different shape on a phone, not the same shape scaled.** The
text takes a line of its own, the controls become round targets beneath it, and
the whole thing is a soft capsule: 24px radius, 38px mic, 42px send, and the
model as a filled pill rather than a bare label. Nothing in the row is under
36px. The input needs no size of its own: the phone's text boost already puts it on
16px, which is where iOS stops zooming the page on focus.

**What becomes a sheet, and what does not.** A long list wants the full width and
the keyboard: the model picker is a bottom sheet on compact, sharing one body
with the desktop popover. Four lines and two controls do not: the context panel
(§54) stays a popup at every size and is simply held inside the viewport. A
drawer for that is more ceremony than content.

**The hints below the input drop a phrase at a time, by container.** They were
bare text inside a flex row, which made every word and every `<kbd>` a separate
flex item with a gap beside it — so the sentence came apart between the words
and then wrapped inside them once space ran short, at around 968px on a screen
with the sidebar open. Each hint is its own element now, ranked, with the
separator drawn as a `::before` on the phrase that follows so hiding the last
one takes its dot with it.

The queries are on the *composer*, not the viewport, because the viewport is not
what constrains them: the room here is the window minus the sidebar, divided by
the interface zoom, and both of those move on their own. A container query reads
the space that actually exists. The order is least-useful-first — the third hint
goes at 430px of composer, the second at 270px — and below the compact
breakpoint the row is gone entirely (§47).

**A drawer ignores clicks that came from its own portaled popups.** Choosing
from a select inside the settings drawer closed the drawer. Both libraries were
behaving correctly and that was the problem: Kobalte renders the option list
through a portal at the end of `<body>`, and Corvu closes on a pointer down
outside `<Dialog.Content />` — which, in the DOM, is exactly where the option
is. They are separate libraries with separate layer stacks and no way to know
about each other. So the drawer declines the dismissal when the pointer landed
inside a floating layer: `[data-popper-positioner]`, a dialog, a tooltip, or
another drawer. Clicking the scrim still closes it, which is the behaviour worth
protecting; only the ones that came from the drawer's own controls are refused.

**A drawer is dragged closed by its header, and nowhere else.** Corvu treats a
drag anywhere on the drawer as a dismissal, which is right for a sheet of static
content and wrong for one that is mostly a scrolling list: a list that reaches
its end, a row that does not scroll, or a swipe a few degrees off-axis all
handed the gesture to the drawer, and it closed while someone was reading. The
library's escape hatch is an attribute it looks for on the way up from the touch
point, so confining the drag means marking everything that is *not* the
header — the body, the footer, the error strip — rather than marking the handle.
The header takes `touch-action: none` to match, since a handle wants the gesture
rather than any panning the browser might do with it.

**The keyboard hints go on a phone, and the context dial with them.** There are
no such keys to name, and the space below the input is worth more than a
reading — the dial lives in that row, so hiding the row hides both.

---

## 48. Global settings

Some configuration should not be repeated in every workspace file.
`~/.picone/settings.json` (under `PICONE_DATA_DIR`) holds it:

```json
{
  "mcpServers": {
    "github": { "command": "github-mcp", "enabled": true }
  },
  "skillPaths": ["~/work/skills"]
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

Both `mcp` and `mcpServers` are accepted as the key, so a config can be pasted
across from Claude Desktop or Cursor without renaming anything. `skillPaths` is
also accepted as `skills`, its older name, since this file has no UI to migrate
it and the word should mean the same thing in both files.

**This file has no UI.** It holds the two things that are not per-workspace
choices, and both are lists of paths and commands rather than switches — the
settings drawer is for deciding which of the discovered resources a workspace
uses (§35), and a global add-form does not belong beside that. Problems parsing
the file surface in the drawer's General section, since otherwise a typo would
be silent.

*Switching extensions off used to live here, as `disabledExtensions`. It is now
per workspace, in the `extensions` record; the old key is reported as ignored
rather than quietly honoured.*

---

## 49. App settings

The settings drawer holds two groups, because the two halves answer to
different owners:

* **Workspace** (§35) — written to `workspace.json`, shared with whoever else
  opens the project, and saved explicitly.
* **App** — how the app behaves, rather than how the project does. Appearance
  and notifications are per *browser*: applied the moment they change, kept in
  `localStorage`, never sent anywhere, because syncing a font choice across
  machines would be a liability rather than a feature. Memory directories (§50)
  are the exception, and per *machine*: a path is a fact about the filesystem,
  so they live in `~/.picone/settings.json` and save through the server. They
  still apply on change, so the group behaves consistently even though its
  halves are stored differently.

The app group comes first: it is the half that works whatever else is going on,
and the half a new user is most likely to want. Workspace sections are disabled
while no workspace is open; the app ones stay reachable, which is the point of
separating them.

**Appearance.** Theme (system, light, dark — `system` re-resolves when the OS
flips), two size controls, and the two font families. A font is stored as a CSS
family list with the bundled stack appended as a fallback, so a name that is not
installed degrades to Inter rather than to Times New Roman. A live sample sits
under the controls, because a font choice cannot be judged from its name.

**Two sizes, because they answer different complaints.** *Interface size* is a
`zoom` on the root element: everything grows together, which is what you want
when the whole app is too small to work in. It re-lays-out rather than
stretching, so hairlines and glyphs stay crisp at any scale.

It goes on **`#root`, not `html`**, and the difference is not cosmetic. A popper
is portalled to `body` and positioned from `getBoundingClientRect`, which
reports physical pixels; inside a zoomed tree that translation is then scaled a
second time, so every menu drifted further from its trigger the larger the
interface got — 399px adrift at 140%. Zooming `#root` leaves the portal layer in
an unzoomed coordinate space where the arithmetic is already right, and the
portalled *content* is zoomed individually. Positioners are deliberately left
alone: they are the part that has to stay in physical pixels.

*Font size* is the body text in **pixels** — 13px is the design, 11 to 16 the
range — because that is the number a person actually has an opinion about. It is
stored as px and divided by the design size into `--font-scale`, which every
`font-size` in the CSS multiplies: the system (§42) is written in absolute
pixels, so this is applied a declaration at a time rather than through a single
root rule.

It applies to what you **read**, not to the machinery around it — the file tree
and session list, the transcript, the contents of a file tab. Growing the text
in a settings drawer or a title bar helps nobody, that being what interface size
is for, and chrome that resizes with the prose makes the window feel unstable.
`--font-scale` is inherited, so scoping it is a matter of declaring it on those
panes rather than at the root: every `calc(Npx * var(--font-scale))` keeps
working and resolves to 1 everywhere else. The panes restate the base size as
well as the variable, since transcript prose has no size of its own and would
otherwise keep inheriting the body's.

Text that grows inside a box that does not is how a design gets cramped and then
clipped, so the boxes grow too. Every single-line row — tree rows, tabs, the
title bar and its chips, buttons, inputs, icon buttons — is
`min-height: max(Npx, calc(Npx * var(--font-scale)))`: the design's height is a
floor, never a ceiling. At 13px every one of them measures exactly what it did
before this existed; at 16px they grow with the text and keep their proportions.
Icon glyphs keep their own size — a pictogram need not grow for its hit area to.

The one thing zoom does not fix is lengths measured against the viewport, which
stay in unzoomed pixels and so render `--ui-scale` too large. `--vh` and `--vw`
in `base.css` are the corrected units, and the safe-area and keyboard insets are
divided down the same way. `position: fixed` needs no correction — it is laid
out against the real viewport already.

**Notifications.** Off until switched on, since asking for the permission
unprompted is rude and browsers punish it. Turning it on requests the permission
from inside the click, which is the only place browsers will grant it. Three
triggers — a turn finishing, a tool needing permission, an error — each with
their own switch, and by default only while Picone is not the focused window: a
notification for something you are watching happen is noise. Clicking one
focuses the window and opens the session it came from.

A notification is always a courtesy. Every one of them is also in the
transcript, so a blocked permission, an insecure origin, or a browser without
the API costs nothing but convenience — which is why the panel says plainly when
the origin rules them out rather than leaving a switch that does nothing.

**On a phone the drawer is two screens, not a tab rail.** Ten sections in a
horizontal strip is a strip narrower than its own labels, so compact layouts get
the platform convention instead: a grouped list you tap into, a back arrow, and
the section name in the header. The panel heading is hidden there, since the
header already says it. The rail and the list are the same `GROUPS` array —
there is one definition of what sections exist, and the layout decides how to
show it.

---

## 50. Memory directories

A folder of long-lived notes about the user — who they are, what they are
working on, who they know — that the agent reads as a matter of course. Added
once for the app, then switched on or off per workspace, with a workspace free
to add its own.

### A store worth having documents itself

The design turns on one observation. A real memory store already carries its own
`AGENTS.md`: its layout, its citation conventions, which trees are frozen, how
to append to its log — and an `index.md` cataloguing every page with a one-line
hook.

So Picone does not describe a memory directory. **It hands over the directory's
own description.** That is what makes the feature general rather than shaped
around one store: any folder that explains itself works, and one that does not
gets a generated listing instead.

### Configuration

Global, in `~/.picone/settings.json`; per workspace, in its JSON. Both are a
record keyed by name — the shape `mcp` and the resource switches use:

```json
"memory": {
  "molly": { "path": "~/notes/memory", "writable": true }
}
```

```json
"memory": {
  "molly": { "enabled": false },
  "notes":  { "path": "./docs/notes" }
}
```

**They merge field by field, not entry by entry.** This is the one place the
memory record differs from `mcp`, where a workspace entry replaces the global
one wholesale. `{ "enabled": false }` has to mean "not here" without restating
where the directory lives, so a workspace entry with no `path` is a decision
about an inherited directory rather than a new one. A name that resolves to no
path at all — a global entry since renamed — becomes a diagnostic rather than a
silent nothing.

### In the files view

A memory directory is a first-class root. The tree lists it, files open as tabs,
selections can be commented, the filename filter finds them, git marks show if
the store is a repository, and the watcher flags a file that changed on disk.
Most of that is free: `app.roots` already feeds every file endpoint. What is
built is the marking — a `memory` tag on the tree root and in the file toolbar,
and memory roots sorted after the project.

Two consequences worth naming. **The watcher earns its keep here**: project
files change because the agent changed them, but a memory store changes because
something else is maintaining it, possibly while you are reading it, so §24's
stale-file affordance becomes the normal case rather than an edge one. And **a
comment on a read-only memory file is still worth making** — it reaches the
session as ordinary input and the agent can read, explain, or act on it
elsewhere.

It is deliberately *not* a `directories` entry. The cwd stays the first project
root, and the workspace context (§6) lists only project directories, so the
agent does not go hunting for source files in someone's diary.

### What the agent is told

Through `agentsFilesOverride`, the same door as the workspace description, so
Pi owns it from there and it is never re-injected:

1. **A header** naming each directory, its absolute path, whether it is
   writable, and whether it has a catalog — plus the instruction to read the
   catalog first, since these stores are far too large to read whole.
2. **Each directory's own `AGENTS.md`, verbatim**, capped at 32 kB with a
   truncation note.
3. **A generated listing** for a directory without one.

`index.md` is pointed at, never injected: it is a catalog, Pi has file tools,
and its bulk belongs in a read the agent chooses to make. In practice the agent
does exactly that — asked what it knows about the user, it reads `index.md`,
then the one page it needs.

### Adding one

Through a dialog carrying the same `PathBrowser` as the workspace picker (§3),
with Tab completion, `..`, drive listing and all. Typing a raw path into a
settings field asked the user to be their own file manager, and a memory store
is somewhere you go and look at before you commit to it — the listing showing
an `AGENTS.md` is exactly the reassurance you want first. The name defaults to
the folder's own, and writability is offered where it is owned, in the global
panel.

A trailing separator is significant while browsing — it is what asks for a
listing rather than a prefix match, so `inspectPath` preserves it — and has no
business in a config file, so it is dropped on the way in.

### Writable means writable

`writable: false` is enforced by the permission gate's path check (§9), not
merely stated in the context. Both halves matter and they do different work:
the statement stops the agent from *offering* an edit it would be denied, and
the enforcement stops the edit when something offers anyway. A store that took
months of someone's life to accumulate should not depend on a sentence being
obeyed.

The refusal distinguishes the two cases, because they read very differently to
whatever receives them:

```text
… is in "…/memory", which is read-only. Read it freely, but say what you
would change rather than changing it.

… is outside this workspace, and writing outside it is never permitted.
```

---

## 51. Media and references in the flow

When the agent mentions something viewable, show it. An image it just wrote, a
diagram, a file, a directory, a URL — a transcript that renders these as grey
text makes the reader go and find them, which is work the app is supposed to be
doing.

Two shapes, split by what is useful to *see* rather than by file type. Small
things are **pills**: an icon, a name, one line, inline with the prose. You want
to know a file was touched and be able to open it, not look at it. Substantial
things are **boxes** that take their own block and show the content: an image, a
sound, a video, a diagram.

**Detection is liberal; resolution is the filter.** `lib/references.ts` scans
prose for anything path-shaped and hands the candidates to the server, which
answers whether each one exists and whether it is a file or a directory
(`POST /api/files/resolve`). Anything that fails to resolve renders as the plain
text it always was. That division is the whole design: the scanner is allowed to
be wrong, because being wrong costs one entry in a batched lookup rather than a
broken link in the page. It is a pure function with tests, which is what makes
tuning the heuristics cheap.

It still has to reject the shapes that would otherwise flood every batch, and
those are more interesting than they sound. `and/or`, `24/7` and `2026/08/09`
are all path-shaped. So is `/etc/hosts` — *identically* so to `and/or`, two
lowercase words around a slash — and the only thing separating them is an
explicit anchor: a leading separator, `./`, `../`, `~/`, or a drive letter.
Slash commands are the reverse trap: `/new` and `/settings` are anchored and are
not paths, so an anchored candidate needs at least two segments. This app's own
transcripts are full of both.

**Batched, cached, one request per render pass.** A single message can mention a
dozen paths and every re-render re-encounters them; the whole of DESIGN.md — 68
kB, 199 paragraphs — resolves in one request carrying 40 candidates. The cache
lives for the life of the page and is thrown away when the workspace changes,
because a miss under the old roots may well be a hit under the new ones.

Resolution tries each workspace root in order and takes the first hit, since a
mentioned path is usually written relative to one. A bare `AGENTS.md` therefore
resolves to whichever root has one — worth knowing when several do.

**The renderer walks marked's tokens rather than setting `innerHTML`.** This is
the change that made the rest possible. Putting components inside prose that was
produced as an HTML string means re-parsing markup the sanitizer has already
approved and grafting nodes back in — two passes that disagree about what the
document is. Walking tokens has neither problem and removes the XSS surface as a
side effect: a text token becomes a text node, so there is no markup for model
output to escape from. DOMPurify survives in exactly one place, the raw-HTML
token, which is the only construct that is markup on purpose.

Two costs came with it. marked's lexer hands back source verbatim and leaves
escaping to its HTML renderer, so `&amp;` has to be decoded here or it appears
spelled out; that is `lib/entities.ts`, and it uses `DOMParser` rather than the
usual detached-`<textarea>` trick because a parsed document is inert while
assigning `innerHTML` constructs live elements even off-document. And every
construct marked can emit now needs a case — headings, task lists, table
alignment, `~~del~~` — which is a one-time cost with an obvious failure mode.

**Streaming is about prefixes, not about the finished text.** A half-written
`![alt](pa` must not flicker a broken image, and it does not: marked emits an
`image` token only when the construct completes. A fence is the opposite — the
`code` token appears with the *opening* fence and its text grows chunk by chunk,
so a diagram would be handed an incomplete graph on every tick and would flash
parse errors all the way down. Mermaid therefore waits for `fenceClosed()`, and
until then the block renders as ordinary code.

**Nothing loads until it is nearly on screen**, via `IntersectionObserver` with
a screen of margin. The observer is attached in `onMount` and *not* in the `ref`
callback: Solid runs a ref before the element is in the document, and observing
a disconnected element does not report it when it is finally inserted — an image
in plain view stayed a grey placeholder until an unrelated scroll happened to
wake the observer.

**Mermaid is loaded the first time a diagram is actually on screen**, never
otherwise. It is by a wide margin the heaviest thing the app can pull in —
larger than everything else put together — and most sessions never mention a
diagram. It is also initialised with `suppressErrorRendering`, because a diagram
that fails to parse otherwise draws a bomb and the words "Syntax error in text"
into the document, outside our tree and at whatever size it likes; the parse
error belongs in the block it came from, with the source one click away. Pi
bundles `grok-mermaid`, which is not reusable here: it renders Unicode
box-drawing art for terminals.

**Bytes are served through the same root guard as everything else**
(`GET /api/files/raw`), with `Content-Type`, `ETag`, `Last-Modified` and byte
ranges — the last being what lets someone seek in an audio file rather than wait
for it. `X-Content-Type-Options: nosniff` always, and an SVG additionally gets a
restrictive `Content-Security-Policy` and is only ever shown in an `<img>`,
never inlined: an SVG is an image and a script vector at the same time.

### Deliberate restraint

**Nothing is fetched that was not asked for.** A URL pill shows a globe and a
hostname, not a favicon and not a title card, because either would be an
outbound request that tells a third party which links appear in a private
transcript. An explicit `![](https://…)` is different — that is content the
message asked to display.

**Inline code gets the subtler treatment.** An agent transcript is mostly paths
in backticks; turning every one into a pill would be a wall of pills. A
`` `src/auth.ts` `` that resolves stays code and gains a dotted underline and a
click. Only prose paths and explicit images become pills and boxes.

### Not built

* **csv and json do not expand to a table or a folded tree.** They are pills.
* **PDFs are pills.** A preview needs a renderer, which is a bigger dependency
  than the feature is worth.
* **Preview state is not persisted.** Expanded or collapsed is recomputed from
  the text, and `messages` stays free of view state.

---

## 52. Mentioning someone from memory

Memory directories (§50) are mounted, readable and in the file tree. `@` points
at somebody in them mid-sentence.

**What the agent receives is a pointer, not a page.** A mention appends a short
block to the model-facing copy of the turn — who was meant, where their page
lives, and an instruction to look past it:

```
The user named someone from memory in that message.

**Gio Choi** (person) — start here: `…/memory/people/gio-choi.md`

These are starting points, not the record. Whoever was named may also appear in
journal entries, in meeting notes, and in other pages' `related` lists. Search
the memory directories before concluding something is not there, and read only
what you need.
```

Three reasons it is not the contents. The agent has file tools and §50 has
already told it how to use this store — a mention does not need to re-teach
that, only to say *which subject*. Memory is scattered: a person's page is the
one filed under their name, not everything the store knows about them, and
pasting it in implies otherwise. And the pages run to thousands of words, so
attaching a few would crowd out the conversation while still being less than the
agent could have fetched for itself.

The wording carries the weight. *Here is where to start* leaves an agent free to
search; anything that reads as *here is the relevant material* is how a capable
agent gets talked out of searching.

A name with no page still gets a line — *no page is filed under that name* —
because a missing page is not a missing person, and that is exactly when looking
around is worth more than a pointer would have been.

**The index is for the menu.** `memory/subjects.ts` walks the enabled roots and
reads only the first 4 kB of each page: frontmatter, first heading, first
paragraph. Cached against every file's mtime, so an edit invalidates and nothing
else does. A page that declares `type:` keeps it; one that does not is typed by
the folder it is filed in, which is not a guess — a store that puts notes in
`journal/` has said what they are. `path` is the only field the agent ever sees.

Nothing here invents a schema. A memory store is somebody's notes: a store with
no frontmatter still yields subjects, they just have no type.

**`@` is the same gesture as `/` (§43)** — type a sigil, narrow a list, complete
a token — so it reuses the shape and the keyboard. One difference drives the
implementation: a slash command is the whole message, while a mention happens
inside a sentence. The menu is therefore anchored to the **caret** rather than
to the field, the sigil must follow whitespace or an opening bracket so an email
address never opens it, and Escape closes the menu without clearing what has
been typed. Exactly one menu is open at a time and the keyboard belongs to it.

**What lands in the message is literal text — `@gio-choi`.** Same reasoning as
comment matchers (§17): text survives editing, copy-paste, reload, and being
read by something that is not this app. The server re-resolves mentions when the
turn is sent, and one that no longer resolves degrades to the words the user
typed. The *composer* holds more than that while the sentence is being written
(§57) — a mention there is a node carrying a slug — but what it sends is these
words, and the stored message is nothing but words. In the transcript a resolved mention renders as `@Name` in purple — the same
"this came from the store" signal the memory tag in the tree uses — and opens
the page in a tab. Coloured type and nothing else at rest: no border, no fill,
and the size of the sentence it sits in. A box drawn around every mention turns
a paragraph into a row of buttons; the fill arrives on hover, which is when you
are asking about it.

It is a `span`, not a `button`, and that is not cosmetic. Blink coerces a button
to `inline-block` whatever the stylesheet says, and an inline-block rides above
the words either side of it. A mention is a name inside a sentence, so it has to
be a genuinely inline box — which means carrying the button's keyboard
behaviour by hand.

The same trap sits in the reference pills of §51, which *are* inline-flex: an
inline-flex box takes its baseline from its **first flex item**, and that is the
icon, which has no baseline — so the browser synthesises one from its bottom
edge and hangs the whole pill from there. `align-items: baseline` with the icon
opted out via `align-self: center` hands the job to the label, and the name
lands on the line it belongs to.

### Not built

* **No mode where the agent answers *as* the mentioned person.** The pointer is
  the useful part; that is a much larger feature with its own problems.
* **No completion menu for paths, and no mentioning a session at all.** Files
  became mentions later (§57), but they arrive by being dragged in from the tree
  or a tab. The `@` menu stays the memory store's: a completion list over every
  path in a workspace is a different feature with a different index behind it.

---

## 53. Rewinding and forking a session

A Pi session file is not a transcript. It is an **append-only tree**: every
entry carries an `id` and a `parentId`, and the "leaf" is where the next entry
attaches. Branching is moving the leaf. Picone used only the trunk, so a
conversation that went wrong could be abandoned but not revisited.

Two operations, and the difference is the point.

**Rewind** goes back to just before one of your messages, in the same session.
Pi's `navigateTree(entryId)` does the work: for a user message it sets the leaf
to that message's *parent*, hands back the text, and rebuilds the agent's
in-memory messages from the new branch. Say it differently and the new exchange
becomes a sibling of the old one.

**Fork** is the same point in a session of its own, leaving the original alone.
`createBranchedSession` writes the path up to an entry into a new file — but it
*switches the manager it is called on* to that file, which would hijack the live
session, so it runs on a throwaway `SessionManager.open()` of the same path and
only the returned filename is kept.

Both open with the message back in the composer rather than already asked. A
rewind you cannot edit is just a delete.

**Nothing is ever deleted.** After rewinding past two messages the tree holds
both paths as siblings; the file grows, and Pi can still reach either leaf.

**Finding the entry id was the interesting part.** Pi has an `entry_appended`
event, and it is a trap: it fires only for entries an *extension* appended,
never for ordinary messages. What Pi does offer is the branch, and the user
messages on it are the same sequence, in the same order, as the user items in
our transcript (§37) — which is not Pi's, and holds things Pi never sees like
permission cards. So after every turn the two are walked together and each user
item is stamped with the entry it became.

The alignment is checked as it goes. The entry holds the *model-facing* text,
which for a mention (§52) has a pointer block appended, so the test is that the
entry starts with what was displayed; the moment they disagree it stops. A
missing id costs the rewind affordance on that message, which is the right way
to be wrong — an affordance that cannot work is worse than none, so the buttons
only appear where there is a node to go back to.

**Our transcript is truncated to match**, in memory and in the `messages` table.
It is what the browser draws, not a record of everything that ever happened;
Pi's file is that. A forked session is seeded with the history it inherited, so
its chat shows the conversation its agent actually remembers rather than opening
blank on top of a full context.

**Rewinding says what it did.** Picone cannot switch between branches yet, and
silently removing messages from the screen while keeping them on disk is the
kind of thing a user discovers by accident. One notice, in the transcript, at
the point it happened.

### Not built

* **No way to switch to an abandoned branch.** The tree is intact and Pi's own
  interface can reach it; Picone shows one path at a time. A tree view in the
  Sessions section is the obvious home for this.
* **No branch summaries.** `navigateTree` can spend a model call describing what
  was abandoned, which is worth having when rewinding past real work and pure
  cost when fixing a typo. It needs a choice in the UI before it is worth
  wiring.
* **Comments do not follow a branch.** A comment (§16) anchored to a message on
  an abandoned path still exists and still points at its file. That is
  harmless — comments anchor to files, not to messages — but it means a
  conversation about a comment can end up on a path the agent no longer sees.

---

## 54. Compaction and context

Pi compacts natively and Picone barely acknowledged it: one notice saying
"Compacting conversation history…" and nothing else. A compaction that failed,
or was cancelled, left that as the last word on the subject — and one that
succeeded never said what it had done. Compaction is the one operation that
*discards history*, so it is the one that most owes an account of itself.

**What Pi provides**, all of it already there:

| call | what it does |
|---|---|
| `AgentSession.compact(customInstructions?)` | summarise and drop, aborting the current run first |
| `abortCompaction()` | cancel one in progress |
| `setAutoCompactionEnabled(b)` / `autoCompactionEnabled` | the automatic threshold pass |
| `getContextUsage()` | `{ tokens, contextWindow, percent }` |
| `compaction_start` / `compaction_end` | with `reason: manual \| threshold \| overflow` |

Automatic compaction runs on a threshold and again on overflow, so it happens
whether or not anyone asks. That is the reason the *end* matters more than the
start: most compactions are not something the user set off.

**Both ends are reported now**, and the reason changes the wording — "context is
full" reads differently from "compacting", and only one of them explains why the
conversation stopped to do something else. A failure says so, a retry says it is
retrying, and a cancellation says the conversation is unchanged.

**Context usage is sampled, not subscribed.** Pi offers it as a reading rather
than an event, so it is taken at the three moments that move it: a turn ending,
a compaction ending, and a session opening. `tokens` is null until a reply comes
back — a real state immediately after compaction, not an error — and the meter
simply disappears rather than showing a zero.

**A dial at the right of the hint row, not a control beside the model.** A ring
that fills as the conversation grows, sitting at the far end of the hints below
the box rather than among the model picker and the send button, where it would
compete with things you press. No background until hovered — at rest it is a
reading, not a button — and colour only as it fills: amber at 70%, red at 85%.

It shares its baseline with the hints beside it, and getting that right needed
the same fix as the mention pills (§52): an inline-flex box takes its baseline
from its first flex item, and that is the ring — an `svg`, which has none, so
the browser synthesises one from its bottom edge and lifts the whole control off
the line. `align-items: baseline` hands the job to the percentage, and the ring
opts out with `align-self: center`.

Clicking it opens the numbers behind it and the two things worth doing about
them: the tokens used against the window, a switch for automatic compaction, and
**Compact now**. `/compact` does the same from the composer.

That is where the auto-compaction switch lives rather than in settings, because
it is the answer to the question the dial provokes. It writes Pi's own flag,
which is global to Pi and seen by the CLI too, so Picone reads it back after
setting rather than keeping a copy — the same treatment as the session name
(§26). It is applied to every loaded session, not only the active one, or a
session left holding the old value would disagree with the setting that governs
it.

Two details the reading forces. `tokens` is null until a reply comes back, so
the dial disappears rather than showing zero — right after a compaction, an
empty ring would claim an empty context instead of an unknown one. And the test
is `percent !== null`, not `percent`, because zero is both a real reading and a
falsy one; testing the number hid the dial on a fresh session.

### Not built

* **No custom compaction instructions.** `compact()` takes them; there is
  nowhere to type them, and a prompt for it would be in the way far more often
  than it was useful.
* **No `compaction` entry in the transcript.** Pi records one in its session
  tree; Picone shows the notices instead, which say the same thing in the place
  the reader is already looking.

---

## 55. What an extension can draw

Covered in §31, where the `ExtensionUIContext` mapping lives. Named here so the
references from the code resolve: extension surfaces are keyed by session,
component factories are rendered to lines, and `ui.custom` runs on the server
with its lines and keystrokes crossing the wire.

---

## 56. Structured tool results

Pi lets a tool return `details` beside its text output — arbitrary JSON, no
schema — and extensions use it to say what they did in a form other than prose.
The todo tool sends its entire task list there. Picone kept only `details.patch`
and discarded the rest, so a tool that had already done the work of describing
itself structurally was rendered as the sentence it wrote for the model.

**Shape, not name.** The obvious way to draw a task list is to check whether the
tool is called `todo`. The better way is to check whether the value *is* a task
list — `tasks: [{ id, subject, status }]` — because the shape is the actual
contract and a second extension emitting it should render the same way. Every
task must typecheck before the list is claimed: half-recognising a shape renders
half its rows, which is worse than not recognising it.

**Everything else is laid out by shape too, and this is the part that matters.**
A renderer per extension does not scale past the extensions someone has bothered
to write one for. But the shapes repeat even when the meanings do not: a list of
records is a table whether the records are subagent runs or search hits; a flat
object of scalars is a row of fields. So `describeDetails` reads one level down
and picks a layout from what it finds, and an extension nobody has heard of gets
a table for free. One level and no further — nesting past that is structure we
would be guessing at, and a wrong guess reads worse than the JSON, which is at
least honestly shapeless.

**Unknown tools get their arguments as words.** `summarizeArgs` fell back to
`JSON.stringify`, which put `{"action":"update","id":4,"status":"completed"}` in
the transcript — mostly punctuation. Values carry the meaning, so the ones whose
keys are self-describing (`action`, `status`, `mode`) are shown bare and the
rest are labelled: `update · id 4 · completed`.

**`details` is capped at 16 KB and dropped if it does not serialise.** These are
written to the database with the row. A tool that returned a whole file in
`details` would otherwise store it twice — once as text, once as structure.

---

## 57. What the composer is holding

The field was a `<textarea>` and the draft was a string. `@gio-choi` was found
again by regular expression every time it had to be drawn, deleted or sent —
and that works right up to the point where a mention has to carry an identity
its label does not spell out. Two files are called `notes.md`. `@sarah` does not
say which Sarah. Structured to text is safe; text back to structured is a guess.

**The draft is a document.** `lib/draft.ts`: a list of nodes, each one text or a
mention, and a mention carries the id it stands for beside the label it shows.
Everything else is derived from it — `draftText` for the transcript and for what
goes back in the field on a rewind, `draftForModel` for what the agent gets, and
those are deliberately different. A file mention reads as `@notes.md` and is
sent as its absolute path, which is the thing that can be opened and the thing
its comments are matched against (§17). A memory subject reads as `@Gio Choi`
and is sent as `@gio-choi`, because the server has resolved those since §52 and
still should.

**The field is `contenteditable`, and the pill is a real inline node** —
`contenteditable="false"`, so the browser gives one press of backspace, one step
of the arrow key, and no caret stranded in the middle of somebody's name. All of
that is free from the DOM and none of it is free from a textarea with pills
painted behind it, where the caret has to be reimplemented and gets it wrong the
first time text wraps.

One thing has to be read *past* rather than read: every engine keeps a trailing
`<br>` inside an editable box so the last line has a height to click into, and
it appears the instant a field is emptied. Taken at face value it is a newline,
which meant an emptied composer held `"
"` forever — never equal to empty, so
the placeholder never came back and a dropped file led with a blank line. A
trailing `<br>` that is the last child is the browser's; a real trailing newline
is two of them, and the first still counts.

Editing belongs to the browser. `DraftField` reads a model out of the DOM after
each change and writes back only for things the user did not type — picking a
mention from the menu, a file arriving from the tree, clearing after send.
Rewriting the DOM on every keystroke is what breaks undo, IME composition and
mobile keyboards, and it breaks them in ways that are hard to see from a desk.

Deletion is intercepted on `beforeinput` rather than `keydown`: that is where
the browser says what it is *about* to do, so one branch covers a backspace, a
soft keyboard's delete, and whatever an IME means by it — and only when a
mention is the thing that would otherwise be half-eaten.

A drop is intercepted in the same place, for a different reason. What a browser
inserts on a drop is the drag's `text/html`, so a sentence dragged out of the
transcript arrives wearing that page's spans, weights and colours in a field
that has no formatting — and worse, wearing them invisibly, since the draft is
read back as text and the markup only shows up as a font that will not go away.
`beforeinput` is a *later* hook than the `drop` event, and that is exactly why
it is the right one: cancelling the drop cancels the whole gesture, including
the half of a move that takes the text out of where it came from, while
cancelling only the insertion leaves the browser to do that half itself.

**Two flavours on the clipboard, and the same two on a drag.** `text/plain` so
a copied draft pastes as words anywhere else, and
`application/x-picone-draft` so it comes back into this field with its mentions
intact. A drag out of the field clears the drag store before setting those two,
because the browser would otherwise attach the selection's markup as `text/html`
and a mention would land in another editor as a styled box rather than a name. Mentions are rebuilt *only* from our own payload
— a `@notes.md` copied out of a chat window is words, because which file it
meant is not in there, and inventing one attaches the wrong identity to the
right-looking label. A payload that does not parse exactly is refused rather
than half-trusted; `text/plain` is always underneath it.

**A mention arrives from three places, and only three**: the `@` menu, a row
dragged out of the file tree, and a file tab dragged onto the field. The drag is
pointer-based (`lib/drag-path.ts`) with a ghost drawn under the cursor, because
HTML5 drag on a `<button draggable>` does not start in Blink and there is
nothing to see while it does not.

The composer had a plain `drop` handler as well, which took any `text/plain` and
made a mention of it. Anything dragged in — a paragraph out of the transcript, a
URL from another window — became a pill claiming to be a file at that path. So
it is gone: the two things that *know* they are handing over a file both go
through `mentionPath`, named for what it makes rather than where it goes, and
everything else dropped on the field lands as the plain text it says it is. A
drop target that accepts everything cannot tell you what it accepted.

### Not built

* **No undo of a programmatic mutation.** Inserting a mention and deleting one
  atomically are our writes, not the browser's, so they are outside its undo
  stack. `document.execCommand` would keep them in it and is deprecated to the
  point of being unreliable; a custom stack is a bigger thing than this.
* **No rich text.** Bold, links and lists are not in the model, and a paste that
  contains them contributes its text. The field is a sentence with names in it.

---

## 58. A second agent

Picone ran Pi and only Pi. Claude Code is the second, chosen per session, and
the reason to add one is not a preference between them: the app's own surfaces
— comments (§16), the permission gate (§9), mentions (§52), the file tree,
voice (§29) — are agent-neutral ideas that only one agent could benefit from,
and a second backend is the only honest test of the seam in §8.

**One `query()` per loaded session, in streaming-input mode, held open.** Not
one per turn. Streaming input is what makes `interrupt()`, `setModel()`,
`getContextUsage()` and the hooks available at all; a fresh query per message
would re-pay process start every turn and lose every one of them. A turn is a
push into a queue the SDK's input generator drains. The cost is a `claude`
child process per *loaded* session, which is what §38's eviction is for, and
why `dispose` closes the query.

**The permission gate is two surfaces, and it has to be.** `canUseTool` looks
like the hook to use and is not: it is never consulted for a tool the CLI
approves by itself — a `Read` goes straight through — and a bare name in
`allowedTools` shadows it entirely. A `PreToolUse` hook *is* consulted for
every call, and a `deny` from it is final, arriving at the model as an error
with our sentence in it. But a hook cannot *grant*: an allowed `Write` still
came back `permission_denied`, because the CLI's own layer has nobody to prompt
in a headless session. So the hook decides — it is the only surface that sees
everything — and `canUseTool` carries the decision out for the calls that would
otherwise have been prompted. Both receive the same `toolUseID`, so the hook
records its verdict under that id and the callback looks it up rather than
asking the human twice.

This leaves the CLI's own deny rules in force underneath ours, which
`bypassPermissions` would not. A bug in our hook fails closed.

`classifyToolCall` needed almost nothing: it matches lower-cased names, so
`Bash`, `Read`, `Write`, `Edit`, `MultiEdit`, `Glob` and `Grep` classify
correctly on the first try — an accident of having written the policy around
what a tool *does*. `NotebookEdit` was the exception, because it names its file
`notebook_path` and nothing else does, so its target was never checked against
the writable roots.

**Picone's own tools** — `resolve_comment`, `list_open_comments`, `speak` —
go in as an in-process MCP server and reach the model as
`mcp__picone__resolve_comment`. They are marked `alwaysLoad`: left deferred
behind tool search, the model spends a call finding `resolve_comment` before it
can resolve anything, and a comment the agent cannot close is a comment that
stays open (§23). Their descriptions are copied from `pi/tools.ts` deliberately
— the wording is the part that matters and should not drift between agents.

**The session id is ours.** Picone's session ids are already UUIDs and the SDK
accepts one, so a session is the same id on both sides with no mapping table.
It is only offered back as a *resume handle* once a turn has completed under
it: resuming an id the CLI never wrote does not fail loudly, it fails the turn
that tries, quietly, as `error_during_execution` with an empty result.

**What is not shared.** Claude spawns its own MCP connections from the same
workspace configuration, so a server used by both agents runs twice — sharing
would need a bridge between two tool systems. `settingSources: ["user",
"project"]` brings in the user's own `~/.claude` skills, subagents and
`CLAUDE.md`, which is the analogue of Pi discovering the user's global skills;
isolation is not total either way, since plugins and CLI defaults are not
settings.

**The workspace description** (§6) and each memory directory's own `AGENTS.md`
(§50) are appended to the `claude_code` system prompt preset, and every root
the workspace opens — hidden ones included (§3) — goes in as an additional
directory, so the agent can reach what the file tree deliberately does not
show.

### Choosing one

Per session, not per workspace: the same project is worth asking two different
agents about, and a conversation cannot change its mind halfway through — the
history belongs to whoever has been having it. The `+` stays one click and
takes the workspace's usual agent; the caret beside it chooses, and choosing
also sets the workspace default, the same bargain the model picker makes.
`/new claude` does the same from the composer.

An agent that cannot run is listed with its reason rather than hidden. "No
Claude executable found" is a thing to go and fix; a missing menu entry is a
thing to wonder about.

Sessions of both kinds live in one list, so a row and a tab carry a
one-character mark — and only when the session is *not* the workspace's usual
agent, because marking everything marks nothing.

The model is stored per agent (`models: { pi, claude }`) because the two do not
share a catalogue: `sonnet` means nothing to Pi and `deepseek-v4-flash` means
nothing to Claude, so one slot could only ever be right for one of them. The
older single `model` key is still read as Pi's. Claude's catalogue can only
come from a live session, so `/api/models` takes an agent and asks the running
session; its effort levels map onto Picone's thinking levels, which are nearly
the same list.

### Finding the executable

The SDK is a thin client for a native binary it installs as an optional
dependency — 283 MB per platform — and it does *not* look on `PATH`: without
that package it fails with "Native CLI binary for win32-x64 not found" rather
than falling back. So the looking is ours: `PICONE_CLAUDE_PATH`, then `PATH`,
then nothing, which leaves the SDK to find its own copy and say so if there
isn't one. A machine that already has Claude Code — which is most machines that
would want this — needs neither the download nor the disk.

### Rewinding without a tree

Pi walks its session file, which is a tree (§53). Claude's is a line, and the
SDK's session API copies one up to a point rather than navigating it — so a
**fork** is `forkSession(upToMessageId)`, and a **rewind is a fork you stay
in**: the history up to that message becomes a new session and this session's
query reopens against it. The abandoned path stays on disk under the old id,
which is the same bargain Pi's rewind makes, and the session's resume handle
changes, which is why it is written back after a rewind as well as after a
turn.

`upToMessageId` is inclusive, and Picone forks from *before* a message so the
new session opens with it in the composer. The cut is therefore the entry
before ours, which means the entry recorded against a message has to be the
right one. Tool results arrive as `user` messages too, so tagging the wrong one
put the handle in the middle of a turn — a fork taken there cut between an
assistant's tool call and its result, and quietly carried across the message it
was supposed to fork before. Only a message the human actually sent is tagged.

### Not built

* **No HTML export**, and no automatic-compaction switch — Claude decides that
  for itself, so there is nothing to offer.
* **No extension UI** (§55). `onUserDialog` and `onElicitation` are the nearest
  thing and they are MCP surfaces, not extension surfaces.
* **File checkpointing is not wired.** `rewindFiles` would restore the files at
  a message, which is the half §53 does not do — the best reason to come back
  to this.
