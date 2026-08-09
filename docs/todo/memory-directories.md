# Memory directories

**Goal.** Point Picone at one or more folders of long-lived notes about the
user — who they are, what they are working on, who they know — and have the
agent read them as a matter of course. Added once for the app, then switched on
or off per workspace, with a workspace free to add its own.

### The insight that shapes the design

A memory store worth having already documents itself. The one this is for,
`D:/dotty-projects/molly/hypogum-next/data/memory`, carries a 16 kB `AGENTS.md`
describing its own layout, its citation conventions, which trees are frozen, and
how to append to its log — plus an `index.md` cataloguing every page with a
wikilink and a one-line hook.

So Picone should not invent a description of a memory directory. **It should
hand over the directory's own.** That also makes the feature general: any folder
that explains itself works, and one that does not gets a generated fallback.

### Schema

Global, in `~/.picone/settings.json` — a record keyed by name, the shape `mcp`
and the resource switches already use:

```json
"memory": {
  "molly": { "path": "D:/dotty-projects/molly/hypogum-next/data/memory", "writable": true }
}
```

Per workspace, in `*.workspace.json` — the same record, where an entry without a
path is switching a global one off, and an entry with a path is a memory
directory of this workspace's own:

```json
"memory": {
  "molly": { "enabled": false },
  "notes": { "path": "./docs/notes" }
}
```

Merged global-first, workspace winning by name. `mergeMcp` in `settings.ts`
already does exactly this; generalise it rather than writing a second copy.

### What Pi is told

At session build, through `agentsFilesOverride` — the same door the workspace
description goes through (§6), so Pi owns it from there and it is never
re-injected:

1. **A header naming the directories**: absolute path, whether writable, and a
   pointer to `index.md` when one exists. Short.
2. **Each directory's own `AGENTS.md`, verbatim**, headed with its path. Capped
   (32 kB) with a truncation note, since context is not free.
3. **A generated fallback** for a directory without one: the top-level entries
   and file count, so Pi at least knows the shape.

`index.md` is *pointed at*, not injected. It is a catalog and Pi has file tools;
the 18 kB belongs in a read the agent chooses to make.

### Where they show up

A memory directory becomes a readable root — the file tree lists it, and
`resolveWithinRoots` accepts it — but **not** a `directories` entry. It is not
project code: the cwd stays the first code root, and `workspaceContext`
describes memory in its own paragraph. `WorkspaceRoot` grows a
`kind: "directory" | "memory"` so the tree can mark it.

### Settings UI

* **App › Memory** — the global list: path, a writable switch, remove, and an
  add row. This is the first App section backed by the server rather than
  `localStorage`, because a path is a fact about the machine, not the browser.
  §49 needs a sentence saying so.
* **Workspace › Memory** — switches for the merged list, plus an add row for
  directories of this workspace's own. Unlike skills and prompts (§35) this one
  *does* get an add button: a memory directory is a path the user chooses, not
  something Pi discovers.

Both take effect in sessions started afterwards, like every other resource; the
file tree updates at once.

### The part with teeth: write policy

**Decided: `writable` is enforced, not advisory.** The permission gate (§9)
classifies by *category* today — files, shell, git — and never by path, so a
read-only marking would otherwise be a promise the UI makes and nothing keeps.
Memory is the first thing in Picone where the difference matters: a store that
takes hours of a user's life to accumulate should not be rewritten because a
sentence in a context file was ignored.

So the gate learns about paths:

* A write tool call resolves its target path and is denied unless that path is
  under a workspace root or under a memory directory marked `writable`.
* Denial is the existing block-with-reason, so the agent is told why and can
  carry on rather than dying.
* The path check runs *before* the category check: `files: allow` grants writes
  inside the workspace, never outside it. This closes a gap that predates
  memory — today `files: allow` lets Pi write anywhere on the disk.
* Shell is the hole this cannot plug. A `bash` call can write anywhere, and
  parsing shell to find out is a losing game; shell stays governed by its own
  `ask` default.

The write-path work is worth doing on its own merits and is the reason this
entry is larger than it looks.

### Seed

The store this is for is
`D:/dotty-projects/molly/hypogum-next/data/memory` — the live one, writable.
Its sibling `hypogum/data/memory` is the older store whose `traits/`,
`struggles/` and `weaknesses/` trees the newer `AGENTS.md` calls frozen; not
registered.
