# Picone

A browser-native coding agent powered by [Pi](https://github.com/earendil-works/pi).

Picone is the environment around the agent — workspace, files, tabs, comments,
permissions, voice — while Pi keeps owning reasoning, conversation, context,
history, compaction, and tool use. See [docs/DESIGN.md](docs/DESIGN.md) for the
full design and [docs/todo/](docs/todo/) for known gaps.

```
workspace.json → Workspace → Files · Chat · Comments · Voice → Pi session
```

## Requirements

- Node.js ≥ 22.19 (uses the built-in `node:sqlite`)
- Pi credentials configured (`pi auth`, or provider env vars such as
  `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`). Picone reads the same
  `~/.pi/agent/auth.json` the Pi CLI uses.

## Getting started

```bash
npm install
npm run dev
```

`npm run dev` starts the API/WebSocket server on `http://127.0.0.1:4319` and the
Vite dev server on `http://127.0.0.1:4318` (which proxies `/api` and `/ws`).
Open the Vite URL. Vite waits for the API before it starts, so the first page
you are served has a server to talk to; expect a second or two of
`waiting for the API…` first.

If it says the API never came up, the log above will say why — most often the
port is still held by a previous run. `PICONE_PORT=4400 npm run dev` moves it.

For a single-origin production run:

```bash
npm run build
npm start          # serves the built UI and the API from :4319
```

Environment variables: `PICONE_PORT`, `PICONE_HOST`, `PICONE_DATA_DIR`
(defaults to `~/.picone`).

## Opening a workspace

On first run Picone asks for a folder. Type or click your way to one and press
**Create** — it writes a `<name>.workspace.json` beside your code and opens it.
Point at an existing workspace file instead to reopen it, or pick one from
Recent.

A workspace is a plain JSON file, so you can also write one by hand.
`workspaces/example.workspace.json` shows every field;
`workspaces/picone.workspace.json` opens this repository.

```json
{
  "version": 1,
  "name": "Acme",
  "directories": ["~/code/acme-web", "~/code/acme-api"],
  "instructions": ["Frontend and backend often change together."],
  "skillPaths": ["~/work/skills"],
  "skills": { "troubleshooting": { "enabled": false } },
  "mcp": { "linear": { "url": "http://localhost:8123/mcp", "enabled": true } },
  "permissions": { "files": "allow", "shell": "ask", "git": "ask" },
  "model": { "provider": "anthropic", "model": "claude-opus-4-5" },
  "voice": { "input": true, "output": true }
}
```

Relative directory paths resolve against the workspace file, and `~` expands to
your home directory. The file stays the source of truth: the settings UI writes
back to it, and the running session is told what changed.

Exactly one workspace is open at a time. Use the workspace name in the title bar
to switch.

## What it does

**Tabs.** Sessions and files share one tab strip. Every open tab stays mounted,
so a background session keeps streaming while you read something else — its tab
shows a spinner. Tabs reorder by dragging. Closing a session tab hides it; the
session keeps running and reopening it from the sidebar restores the transcript.

**Chat.** Streaming responses, tool calls, and permission cards. Enter sends;
while the agent is working, what you send steers the current run. Input always
goes to the last-focused session tab, so opening a file never orphans the
composer.

**Slash commands.** `/` opens a filtered menu of everything Pi knows about in
that session — prompt templates, skills, and extension commands — plus a few
handled in the browser (`/new`, `/close`, `/settings`, `/theme`, `/sidebar`).
Arrow keys to choose, Tab to complete, Enter to send.

Extension commands get a real UI: `select`, `confirm`, `input`, and `editor`
open dialogs, `notify` writes to the transcript, `setStatus` shows a pill in the
title bar, `setWidget` renders a block by the composer, and anything an
extension reports with `pi.sendMessage` gets its own transcript row. Output that
is a TUI component rather than text still cannot cross — see [docs/todo/](docs/todo/).

**Model.** A picker under the composer switches the model on the live session —
it applies to the next turn, mid-conversation — and becomes the workspace
default for new sessions. The badge shows the thinking level Pi is actually
running, which may be clamped up from what you asked for.

**Files.** A lazy-loading explorer over every configured root, with filename
search and git status marks. Files open as read-only tabs — the agent owns file
mutation. Code gets syntax highlighting and line numbers; markdown toggles
between rendered and source.

**Comments.** Select text in any file tab and press *Comment*. The comment is
saved, shown inline against the anchored lines, and injected into the active
session immediately — as steering if the agent is mid-run, otherwise as the next
message. The agent calls `mark_comment_addressed` when it has acted; only you can
mark a comment resolved. Anchors are the selected text plus a line hint, nothing
more: if the file moves on, the agent searches for the text.

**Permissions.** Three categories — `files`, `shell`, `git` — each `allow`, `ask`,
or `deny`. `ask` pauses the run and shows a card with *Allow once* /
*Allow for session* / *Deny*. Read-only git (`status`, `diff`, `log`, …) always
runs. Shell tools contributed by Pi extensions are gated too, not just the
built-in `bash`.

**Voice.** Dictation in the composer via the browser's Web Speech API, and a
`speak` tool the agent can choose to use. Both stay on your machine; no audio
service to run.

**App settings.** Settings has two halves. The workspace half writes to
`workspace.json`; the app half describes this browser on this device and applies
as you change it — theme, interface size, interface and code fonts, and desktop
notifications when a turn finishes, a tool needs permission, or something fails.
Interface size scales the whole UI rather than the text alone, so spacing and
controls grow with it.

**Phone and tablet.** One layout that rearranges rather than a separate mobile
build: the sidebar becomes a drawer, dialogs become bottom sheets, the composer
rides above the on-screen keyboard, and tab reordering works by long-press. It
installs as a PWA, so it runs standalone from the home screen.

**Skills, prompts and extensions.** Pi's own — from `~/.pi/agent` and
`~/.agents` — work here with no configuration. Settings shows what it found, one
switch each, and the workspace file records the decision per item:

```json
"skills": { "troubleshooting": { "enabled": false } }
```

Anything not named there is on, so installing a skill makes it available
everywhere at once. There is no add button: write a skill or prompt template as
a file, install an extension with `pi install`, and it shows up in the list.

**Memory.** Point Picone at folders of long-lived notes about you — who you
are, what you are working on, who you know — and the agent reads them as a
matter of course. Register them once in App settings; each workspace switches
them on or off and can add its own. They appear in the file tree with a
`memory` tag and behave like any other directory: open a file, comment on a
selection, search across them.

What the agent is told about a store is the store's *own* `AGENTS.md`, if it
has one, rather than a description Picone invented — so a folder that explains
itself is understood without any configuration. `writable` is off by default
and enforced by the permission gate, not merely stated.

**MCP.** Pi has no concept of it, so Picone runs its own client and hands the
remote tools to Pi as ordinary tools. Servers are configured by hand in the
workspace file, or in `~/.picone/settings.json` to apply to every workspace —
where a workspace entry of the same name wins. That file also takes extra skill
directories, as `skillPaths`.

## Layout

```
apps/
  server/            Express + ws + the Pi SDK
    src/workspace/   schema · loader · writer
    src/files/       browser · reader · watcher · git
    src/comments/    storage · model-facing formatting
    src/permissions/ policy · gate
    src/pi/          runtime · event translation · custom tools
    src/mcp/         MCP client manager
  web/               SolidJS + Tailwind + Kobalte + Corvu
    src/styles/      design tokens, base, feature CSS
    src/components/  ui/ primitives, then feature components
    src/lib/         api · socket · paths · app settings
    src/store.ts     one Solid store; the event reducer lives here
packages/
  protocol/          type-only wire contract shared by both
docs/
  DESIGN.md          the system as designed and built
  todo/              one file per known gap; done work moves into DESIGN.md
```

`packages/protocol` contains no runtime values, so both sides import it directly
with no build step and every import is erased at compile time. Pi's own event
schema never reaches the browser — the server translates it into the protocol's
`AgentEvent` union.

## UI stack

The web app follows [opencode](https://github.com/anomalyco/opencode)'s design
system and conventions:

- **SolidJS** with a single `createStore` — no context plumbing; the WebSocket
  event reducer folds straight into the store.
- **Tailwind v4** for layout, with opencode's `v2` semantic tokens exposed as
  utilities (`bg-v2-background-bg-base`, `text-v2-text-text-muted`, …).
- **Kobalte** for accessible primitives: button, dialog, select, switch,
  tooltip, text field.
- **Corvu** for the settings drawer, including drag-to-dismiss and a scrim that
  tracks the drag position.
- **CodeMirror 6** for read-only code tabs; **marked** + **DOMPurify** for
  markdown.
- **Lucide** icons, imported one glyph at a time so the bundle only carries what
  is used. `src/components/ui/icon.tsx` maps product names (`comment`, `rename`,
  `panel`) onto glyphs, so swapping an icon never touches a call site.
- **Inter** and **JetBrains Mono**, self-hosted from `public/assets/fonts` — no
  CDN, so the app works offline. See the NOTICE there for licensing.

Styling follows opencode's split: Tailwind utilities handle layout, while
"designed" components are attribute-driven CSS (`[data-component="button"]`,
`[data-slot="line-comment-shell"]`) in `@layer components`. Colour, elevation,
and syntax tokens live in `src/styles/{colors,theme}.css`; light and dark are
the same tokens flipped by `data-color-scheme` on `<html>`, set before first
paint to avoid a flash.

The inline comment card is a direct port of opencode's `line-comment-v2`, in
both its display and editor variants, so a comment looks the same in the
CodeMirror gutter, in a markdown tab, and in the sidebar.

## Storage

Workspace configuration lives only in the JSON file. A SQLite database under
`PICONE_DATA_DIR` holds runtime state: sessions, transcripts, comments, recent
workspaces, and UI state. Conversation history itself is Pi's, in its own session
files.
