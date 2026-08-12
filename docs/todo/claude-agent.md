# Claude sessions are missing half of §53

Picone runs two agents now (§8, §58): a session is a shell around an
`AgentBackend`, and Claude Code is behind one as of this branch. What works is
in DESIGN; what is left is here.

## Rewind and fork

`capabilities.rewind` and `capabilities.fork` are false for Claude, so the
buttons under a message do not appear. Pi navigates its session tree in place;
the SDK's equivalent is `resume` + `resumeSessionAt: <uuid>` + `resumeDropsTurn`,
which rebuilds the conversation by **restarting the query**. That is a different
operation with a different cost, and it needs:

* the query torn down and rebuilt behind the same `SessionRuntime`, without the
  shell noticing more than it does for a model switch;
* `resumeDropsTurn` set to the prompt uuid being discarded, or the CLI refuses
  the resume when anything else landed in the dropped range — a queued message,
  a task notification;
* the same transcript truncation the shell already does for Pi.

Fork is the easier half: `forkSession: true` with a `sessionId` of our own
choosing gives a branched session from a point, which is exactly
`backend.forkFrom`.

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
