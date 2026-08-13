# What Claude sessions still cannot do

Picone runs two agents now (§8, §58): a session is a shell around an
`AgentBackend`, and Claude Code is behind one. What works is in DESIGN — including
rewind and fork, which turned out to be the same operation twice — and what is
left is here.

## File checkpointing

`enableFileCheckpointing` plus `query.rewindFiles(userMessageId)` restores the
*files* to their state at a message. §53 rewinds the conversation and leaves the
disk where it is, so this is the missing half of it and the best reason to come
back here. `capabilities.fileCheckpoints` exists and is false; nothing reads it
yet.

## Two connections to one MCP server

Claude spawns its own from the same workspace configuration, so a server used by
both agents runs twice — wasteful, and for a stateful server possibly worse.
Sharing means proxying Picone's already-connected tools into the in-process SDK
server, which needs a bridge between two tool systems (TypeBox one side, Zod the
other) and a way to describe a tool once for both. The three Picone tools are
already written twice for the same reason.

## Smaller things

* **The dialog protocol is unused.** `onUserDialog` with the `ask_user_question`
  and `plan_review` kinds is the route the CLI means for these (§59); declaring
  both emitted nothing, so they are intercepted in the hook instead. Worth
  revisiting when the kinds are documented — the payloads and result shapes are
  defined per kind and guessing at them is not worth it.

* **The command list refreshes lazily.** The `commands_changed` handler is
  written from the message shape, but writing a `.claude/commands/*.md` under a
  live session did not produce one — the list only came back with `/reload`,
  which does pick it up (`apps/server/scripts/claude-notices.mjs`). The retry and
  authentication notices are in the same position: written, and waiting for the
  world to produce the conditions.
* **No streaming tool output.** The SDK does not forward it — `tool_progress` is
  about subagents, and a fifteen-second `sleep` produced nothing. Picone shows
  how long a call has been running instead, which is most of what the output was
  being read for, but it is not the same thing.
* **`bypassPermissions` and `dontAsk` are not offered as modes.** The first
  would take Picone's gate out of the loop, which is the one thing the gate is
  for; the second denies anything not pre-approved, which is what a workspace
  full of `deny` already says.
* **`/compact` is sent as a prompt**, since Claude has no compaction API. It
  works and it appears in the transcript as a user message, which is not quite
  a lie but is not the way Pi's compaction reads either.
* **The model label shows the id** (`default`), because that is what the picker
  has always shown and Pi's ids are self-describing where Claude's aliases are
  not. Showing `ModelOption.name` instead would change Pi's picker too.
* **Subagents appear in the extensions column** of the resources panel, which
  is where they fit least badly. Claude has no extensions and no prompt
  templates, so two of the three columns are empty or wrong.
* **No settings UI for the executable.** `PICONE_CLAUDE_PATH` is read, and the
  agent menu says when nothing was found, but there is nowhere to type it.
* **Skills are listed, not filtered.** The workspace's `skills: { name: {
  enabled } }` switches are honoured for Pi and ignored for Claude, which takes
  a `skills: string[] | 'all'` at query time and could honour them at session
  start.

## Production

The service account is not the user. Claude authenticated here through the
login already on the machine (`apiKeySource: "none"`); `PiconeServe` runs as a
Windows service whose `~/.claude` is its own and probably logged out. Either it
runs as the user, or `ANTHROPIC_API_KEY` goes in its environment. This will be
the first thing that breaks on deploy.
