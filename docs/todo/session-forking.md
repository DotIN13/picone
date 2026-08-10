# Forking and rewinding a session

**Pi already does this.** A Pi session file is not a transcript, it is an
append-only **tree**: every entry carries an `id` and a `parentId`, and the
"leaf" is where the next entry attaches. Branching is moving the leaf. Picone
currently uses only the trunk, so a conversation that went wrong can only be
abandoned, and one that reached a good point cannot be tried two ways.

Nothing here needs inventing. It needs surfacing.

### What Pi gives us

From `@earendil-works/pi-coding-agent`:

| call | what it does |
|---|---|
| `SessionManager.getTree(): SessionTreeNode[]` | the whole tree, defensive copy |
| `SessionManager.getBranch(fromId?)` | root → leaf path, the "current conversation" |
| `SessionManager.getLeafId()` | where we are now |
| `SessionManager.branch(fromId)` | move the leaf — new branch, **same file** |
| `SessionManager.branchWithSummary(fromId, summary, …)` | same, plus a `branch_summary` entry describing the abandoned path |
| `SessionManager.createBranchedSession(leafId)` | extract one path into a new file |
| `SessionManager.forkFrom(sourcePath, targetCwd, …)` | fork a whole session file |
| `AgentSession.navigateTree(targetId, { summarize, customInstructions, label })` | the high-level rewind: returns `editorText` for a user message, optionally summarises what was abandoned |
| `AgentSession.getUserMessagesForForking()` | `{ entryId, text }[]` — the rewind points |
| `AgentSessionRuntime.fork(entryId, { position: "before" \| "at" })` | new session file from an entry; returns `selectedText` |

Extensions can already observe and veto it: `session_before_fork`,
`session_before_tree`, `session_tree`, `session_before_switch`. Pi's own TUI
binds `app.session.fork` and has a `doubleEscapeAction` setting of
`"fork" | "tree" | "none"`, plus `TreeSelectorComponent` and
`BranchSummaryMessageComponent`.

**Two operations, not one, and the difference matters.**

* **Rewind** (`navigateTree`) stays in the same file. The abandoned branch is
  still there, and can optionally leave a summary behind so the agent knows what
  was tried. This is "go back and say it differently".
* **Fork** (`runtime.fork`) makes a new session file with its own identity. This
  is "keep both, they are going different places".

### What Picone has to build

1. **Persist the tree.** `db.ts` stores `messages` as the rendered transcript
   (§37) and it is flat. It needs the entry `id` and `parentId` alongside each
   row, or the UI cannot address a rewind point. This is the real work; the rest
   is comparatively thin.

2. **A rewind affordance on user messages.** Hovering a user message in the
   transcript offers *Rewind here* — Pi hands back `editorText`, which goes into
   the composer so the message can be edited and resent. This is the interaction
   people actually want and it is one call.

3. **Fork as a session-level action**, beside rename and delete in the session
   list. A forked session is a new row in `sessions` with `parentSessionPath`
   recorded — the column already exists in Pi's header.

4. **Branches need to be visible or they do not exist.** Options, cheapest
   first:
   * a marker on the message where the conversation diverged, with a count, and
     a menu to switch — no new surface, and enough for two or three branches;
   * a proper tree view in the sidebar's Sessions section;
   * nothing, and rely on branch summaries. Probably not: an invisible branch is
     a leak, not a feature.

5. **Protocol and events.** A `session.tree` event so other tabs follow a
   rewind, and `branch_summary` needs a `ChatItem` kind — it is a real entry
   type that will otherwise render as nothing.

6. **Permission and comment interaction.** A comment (§16) anchored to a message
   on an abandoned branch is now pointing at something the agent cannot see.
   Decide whether comments follow the branch or the file.

### Open questions

* **Does a rewind delete anything visually?** It must not delete anything on
  disk — the tree is append-only — but showing the abandoned branch greyed out
  in place is very different from hiding it. Leaning towards hiding it and
  offering a switch, because the transcript is meant to be readable.
* **Summarise the abandoned branch by default?** `navigateTree` can spend a
  model call summarising what was thrown away, which is genuinely useful when
  rewinding past real work and pure cost when correcting a typo. Probably offer
  it, default off, and let the length of the abandoned branch decide the hint.
* **Does forking copy the workspace state?** No — the workspace is on disk and
  shared. Two branches that both edit the same file will interleave, and the
  UI should not pretend otherwise.
