# Mentioning someone from memory, and talking with them

Memory directories (§50) are already mounted, already readable, already in the
file tree. What is missing is a way to *point at somebody in them* mid-sentence,
and a way to hear back from them.

Two features, one trigger, and they should ship in this order because the first
is the substrate for the second.

**Mention** — `@gio-choi` in the composer attaches that subject's memory file to
the turn. The agent answers *about* them, holding the dossier.

**Voice** — the agent answers *as* them, from their file. This is the "talk with
them" part, and it is the one with teeth.

## The subject index

A memory directory is a directory of subjects. In the reference layout each is a
markdown file with YAML frontmatter and a title:

```markdown
---
type: person
last_updated: 2026-08-05T10:05:14-05:00
tags: [colleague, apto]
related: []
---

# Gio Choi

Colleague on the user's weekly APTO Check-In call …
```

So the index is cheap: walk each **enabled** memory root, read the frontmatter
and the first heading and the first paragraph, and emit

```ts
interface MemorySubject {
  slug: string;        // "gio-choi", from the filename
  name: string;        // "Gio Choi", from the H1, falling back to the slug
  type: string;        // "person" | "entity" | whatever the file declares
  summary: string;     // the first paragraph, one line
  path: string;        // absolute, so it can be opened as a tab
  root: string;        // which memory dir it came from
  tags: string[];
}
```

`GET /api/memory/subjects`. Small enough to send whole — the reference memory
has 14 people and 52 entities — and cached against mtime, reusing the watcher
that already exists for open tabs. Files without a `type` are not subjects;
`index.md`, `AGENTS.md` and `USER.md` are excluded by name.

**Do not invent a schema.** Read what is there and degrade: a memory directory
with no frontmatter still yields subjects, they just all have `type: ""` and are
mention-only.

## The `@` trigger

Structurally the same as `/` (§43), which already has the machinery worth
reusing: `Composer.tsx` watches the input, `SlashMenu.tsx` filters
prefix-then-substring and owns the keyboard. An `@` at a word boundary opens the
same menu shape over subjects instead of commands, grouped by type with the
person's one-line summary as the secondary text.

**What lands in the message is literal text — `@gio-choi` — not a hidden
attachment.** Same reasoning as comment matchers (§17): text survives editing,
copy-paste, reload and a transcript being read by something that is not this
app. The server re-resolves mentions against the subject index when the turn is
sent, so a mention that no longer resolves degrades to the words the user typed.

In the transcript a resolved mention renders as a pill — the §51 machinery
already does this, with `data-kind="person"` — and clicking it opens the memory
file in a tab, which works today because memory dirs are roots.

## Mention: attaching the subject

On send, each resolved mention contributes its file to the turn's context, the
same way `memory/context.ts` already injects directory headers. Cap it: whole
files, up to a budget, then fall back to the frontmatter plus headings.

That is the whole first feature, and it is worth having on its own. "What did I
promise @julia-koschinsky?" is a question the agent currently answers by
grepping.

## Voice: talking with them

Entering it must be **deliberate**, never a side effect of typing a name. A
mention is a mention; talking to someone is a mode. Suggest a `Talk with Gio`
action on the mention pill and in the menu, which opens the mode explicitly and
shows a dismissible `speaking as Gio Choi` chip beside the composer for as long
as it lasts.

While the mode is on:

* the turn carries the subject's file and an instruction to answer as them;
* the reply renders as **them** — their name, a distinct avatar, and a visible
  `simulated` tag on every message. Not as Picone, and never as an unmarked
  quotation;
* **no tools.** A simulated colleague that can edit your repository is a
  category error. The persona answers from its file and nothing else;
* **no writes to memory**, regardless of the directory's `writable` flag (§50).
  A simulated person must not be able to add facts about themselves. This is the
  one hard rule here.

### Grounded, and honest about it

These files describe real people, observed from the user's own screen. That
makes the feature genuinely useful — rehearsing a conversation, remembering what
somebody cares about before a call — and it makes one failure mode serious: a
persona that invents biography produces plausible false statements attributed to
a real colleague.

So the persona is grounded rather than imaginative. The memory format already
carries `*Evidence: 2026-08-04 screen*` citations; the persona answers from
recorded facts, cites them when asked, and says *there is nothing in memory
about that* rather than filling the gap. Every message stays labelled as a
simulation in the transcript, and the label travels with a copy.

This is a constraint on the prompt, the rendering and the export — not a warning
dialog. A dialog would be dismissed once and never seen again.

## Open questions

* **More than one at a time?** A simulated meeting with two colleagues is an
  obvious next thought and a much bigger feature — turn-taking, who-speaks-next,
  and each persona seeing the others' lines. Out of scope; do not design the
  single case in a way that forecloses it.
* **Does the main agent see the exchange afterwards?** Yes: it is in the
  transcript, so it is context like anything else. Worth confirming that reads
  well rather than confusing the agent about who said what — the `simulated`
  tag needs to be in the model-facing text too, not only in the CSS.
* **Are entities mentionable?** For attaching, yes — `@chorus-rag-eval` is a
  useful thing to point at. For voice, no: only `type: person`. Everything else
  gets a mention pill and no `Talk with`.
* **Does `@` also mention files and sessions?** The trigger is a natural home
  for "point at a thing", and §51 already resolves paths. Tempting, and probably
  right eventually, but it makes the menu a mixed bag. Keep `@` for memory
  subjects until that is proven useful.
