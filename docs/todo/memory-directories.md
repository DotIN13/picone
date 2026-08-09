# Memory directories

**Goal.** Point Picone at one or more folders of long-lived notes about the
user — who they are, what they are working on, who they know — and have the
agent read them as a matter of course. Added once for the app, then switched on
or off per workspace, with a workspace free to add its own.

## The insight that shapes the design

A memory store worth having already documents itself. The one this is for,
`D:/dotty-projects/molly/hypogum-next/data/memory`, carries a 16 kB `AGENTS.md`
describing its own layout, its citation conventions, which trees are frozen, and
how to append to its log — plus an `index.md` cataloguing every page with a
wikilink and a one-line hook.

So Picone should not invent a description of a memory directory. **It should
hand over the directory's own.** That also makes the feature general: any folder
that explains itself works, and one that does not gets a generated fallback.

## Schema

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
already does exactly this; generalise it to `mergeNamed` rather than writing a
second copy.

```ts
// packages/protocol
export interface MemoryDir {
  /** Absolute, or relative to the file that declares it. Absent = a global entry being toggled. */
  path?: string;
  enabled?: boolean;
  /** Default false. Enforced by the gate, not merely stated (see below). */
  writable?: boolean;
}
export type MemoryDirs = Record<string, MemoryDir>;

/** A merged, resolved entry, which is what the UI and the runtime both consume. */
export interface ResolvedMemoryDir {
  name: string;
  path: string;
  writable: boolean;
  enabled: boolean;
  exists: boolean;
  source: "global" | "workspace";
  /** The directory explains itself. */
  hasInstructions: boolean;
  /** It carries a catalog worth pointing the agent at. */
  hasIndex: boolean;
}
```

## Files

### New

| file | holds |
|---|---|
| `apps/server/src/memory/registry.ts` | merge global + workspace, resolve paths, stat them, produce `ResolvedMemoryDir[]` |
| `apps/server/src/memory/context.ts` | build the injected text: header, each `AGENTS.md`, generated fallbacks |
| `apps/web/src/components/MemorySettings.tsx` | the two panels, one component with an `scope` prop |

### Modified

| file | change |
|---|---|
| `packages/protocol/src/index.ts` | `MemoryDir`, `MemoryDirs`, `ResolvedMemoryDir`; `memory` on `WorkspaceFile` and `GlobalSettings`; `kind` on `WorkspaceRoot`; `memory` on `WorkspaceStateResponse` |
| `apps/server/src/workspace/schema.ts` | validate `memory` — reuse the `resources()` parser, plus `path` and `writable` |
| `apps/server/src/workspace/loader.ts` | resolve workspace-relative memory paths; `workspaceContext` gains its memory paragraph |
| `apps/server/src/settings.ts` | parse/save global `memory`; `mergeMcp` → `mergeNamed` |
| `apps/server/src/app.ts` | own the registry; `roots` includes memory dirs; expose in `state()`; rebuild on workspace or settings change |
| `apps/server/src/pi/runtime.ts` | add the memory block to `agentsFilesOverride`; pass writable roots to the gate |
| `apps/server/src/permissions/policy.ts` | split read tools from write tools; return the paths a call would write |
| `apps/server/src/permissions/gate.ts` | the write-path check |
| `apps/server/src/http.ts` | `memory` on the settings PUT body |
| `apps/web/src/components/SettingsDrawer.tsx` | a Memory section in each group |
| `apps/web/src/components/FileTree.tsx` | mark memory roots |
| `apps/web/src/store.ts` | `memory` in state; save-on-change for the global list |
| `docs/DESIGN.md` | a new §50, plus edits to §5, §9 and §49 |

## What Pi is told

At session build, through `agentsFilesOverride` — the same door the workspace
description goes through (DESIGN §6), so Pi owns it from there and it is never
re-injected. One context file per memory directory, plus one header:

```text
## Memory

Two directories of long-lived notes about the user. Read them before answering
anything about the user, their work, their schedule or the people around them.
They are not project code and nothing in them is a source file.

- molly   D:\...\hypogum-next\data\memory   writable   catalog: index.md
- notes   D:\proj\docs\notes                read-only
```

Then, per directory that has one, its own `AGENTS.md` verbatim under a heading
naming the absolute path. Capped at 32 kB with a truncation note, since context
is not free. A directory without one gets a generated stand-in: top-level
entries, file count, and the largest few files by name.

`index.md` is **pointed at, not injected**. It is a catalog and Pi has file
tools; its 18 kB belongs in a read the agent chooses to make.

## Where they show up

A memory directory becomes a readable root — the file tree lists it and
`resolveWithinRoots` accepts it — but **not** a `directories` entry. It is not
project code: the cwd stays the first code root, and `workspaceContext`
describes memory in its own paragraph rather than in the list of directories.
`WorkspaceRoot` grows `kind: "directory" | "memory"` so the tree can mark it,
and the tree sorts memory roots last.

## Settings UI

**App › Memory** — the global list. This is the first App section backed by the
server rather than `localStorage`, because a path is a fact about the machine,
not about the browser; DESIGN §49 needs a sentence saying so. Saves on change,
like the rest of the App group.

```text
MEMORY
Folders of long-lived notes, offered to every workspace. A workspace can switch
one off or add its own.

┌───────────────────────────────────────────────────────────────┐
│ molly                                                    [×]  │
│ D:\dotty-projects\molly\hypogum-next\data\memory              │
│ (•) writable        107 files · describes itself · has index  │
└───────────────────────────────────────────────────────────────┘

[ name        ] [ path                                ] [ + Add ]
```

**Workspace › Memory** — switches for the merged list, plus an add row for
directories of this workspace's own. Unlike skills and prompts (DESIGN §35) this
one *does* get an add button: a memory directory is a path the user chooses, not
something Pi discovers.

```text
MEMORY
(•) molly    writable    global      D:\...\hypogum-next\data\memory
(•) notes    read-only   this file   .\docs\notes                [×]

[ name ] [ path ] [ + Add ]
Takes effect in sessions started after saving.
```

Rows carry the same affordances as the resource lists: a name, a muted
description, and a right-aligned path. A missing directory shows a `missing`
tag rather than vanishing — a workspace file shared between machines will point
at paths that only exist on one of them.

## The part with teeth: write policy

**Decided: `writable` is enforced, not advisory.** Memory is the first thing in
Picone where the difference matters: a store that takes hours of a user's life
to accumulate should not be rewritten because a sentence in a context file was
ignored.

Today `classifyToolCall` lumps `read`, `ls`, `grep` and `find` in with `write`,
`edit` and `multiedit` under one `files` category, and never looks at where the
path points. So `files: allow` currently means **Pi may write anywhere on the
disk** — which is a gap worth closing on its own, quite apart from memory.

The change:

1. `policy.ts` splits `FILE_TOOLS` into `READ_TOOLS` and `WRITE_TOOLS`, and
   `Classification` gains `writes: string[]` — every path the call would modify.
   `multiedit` carries several; collect them all.
2. `gate.ts` takes a `writableRoots(): string[]` accessor and checks it **before
   the category check**, using the existing `isInside` from `util/paths.ts`:
   a write whose target is outside every writable root is denied with a reason
   naming the path. `files: allow` then means "writes inside the workspace",
   which is what a reader of that setting already assumes it means.
3. Writable roots are the workspace roots plus memory directories marked
   `writable`. Reads are **not** path-checked: reading widely is useful and the
   picker deliberately roams the disk already.
4. The gate is rebuilt, or its accessor re-read, when the workspace file changes
   — `updatePermissions` is the existing hook to extend.

**Shell is the hole this cannot plug.** A `bash` call can write anywhere and
parsing shell to find out is a losing game. Shell stays governed by its own
`ask` default, and DESIGN §9 should say plainly that the path check covers file
tools only.

## Order of work

1. **Path-scoped writes**, alone, with no memory anywhere near it. It is the
   load-bearing piece, it is testable on its own, and it closes an existing gap.
2. **Schema, registry and merge** — types, validation, `mergeNamed`, roots.
3. **Injection** — the context block and the `AGENTS.md` pass-through.
4. **UI** — both panels.
5. **Docs** — DESIGN §50; amend §5 (roots), §9 (write paths), §49 (the App
   group is no longer purely per-device).

## Verification

- A write to a path outside every root is denied, and the reason names the path.
- A write inside a `writable: false` memory directory is denied; inside a
  `writable: true` one it succeeds.
- `multiedit` touching one permitted and one forbidden path is denied whole.
- The injected context contains the store's own `AGENTS.md`, and a directory
  without one gets the generated listing instead.
- A workspace switching a global directory off does not see it in the file tree
  or the context.
- A memory directory does not become the cwd, and does not appear in the
  workspace's `directories` list after a settings save.

## Seed

The store this is for is `D:/dotty-projects/molly/hypogum-next/data/memory` —
the live one, writable. Its sibling `hypogum/data/memory` is the older store
whose `traits/`, `struggles/` and `weaknesses/` trees the newer `AGENTS.md`
calls frozen; not registered.
