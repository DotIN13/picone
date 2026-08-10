# Mentioning someone from memory

Memory directories (§50) are already mounted, already readable, already in the
file tree. What is missing is a way to *point at somebody in them* mid-sentence.

`@gio-choi` in the composer names a subject. What the agent receives is a
**pointer** — who was meant, and where to start looking. Not the file.

## What goes into context

Three lines per mention, and no file contents:

```
The user mentioned **Gio Choi** (person).
Start here: D:\…\memory\people\gio-choi.md

That page is a starting point, not the whole record. This subject may also
appear in journal entries, in other people's pages, and in notes filed
elsewhere in the store. Search before concluding something is not there.
```

Three reasons it is a pointer and not the contents.

**The agent has file tools and knows how to use them.** §50 already injects the
store's own `AGENTS.md` and tells it to read the catalog first and then only the
pages it needs. A mention does not need to re-teach any of that; it needs to say
*which subject* and *where that subject's page lives*.

**Memory is scattered.** A person's page is the page filed under their name, not
everything the store knows about them — they turn up in journal entries, in
meeting notes, in the `related:` list of somebody else's page. Pasting one file
into the prompt implies that file is the answer, which is the one impression to
avoid. Handing over a path and saying *look wider* leaves the agent free to go
and find the rest, and to decide how much of it is worth reading.

**Contents do not fit and do not need to.** These pages run to thousands of
words each. Attaching a few is enough to crowd out the actual conversation while
still being less than the agent could have fetched for itself.

The wording matters more than the mechanism. It should read as *here is where to
start*, never as *here is the relevant material* — the second phrasing is how a
capable agent gets talked out of searching.

## The subject index

The index exists for the **menu**, not for the prompt. Walk each enabled memory
root and emit one row per subject:

```ts
interface MemorySubject {
  slug: string;        // "gio-choi", from the filename
  name: string;        // "Gio Choi", from the H1, falling back to the slug
  type: string;        // "person" | "entity" | whatever the file declares
  summary: string;     // the first paragraph, one line, for the menu only
  path: string;        // absolute — this is the part the agent gets
  root: string;
  tags: string[];
}
```

In the reference layout each subject is a markdown file with YAML frontmatter
and a title:

```markdown
---
type: person
tags: [colleague, apto]
related: []
---

# Gio Choi

Colleague on the user's weekly APTO Check-In call …
```

`GET /api/memory/subjects`, cached against mtime, reusing the watcher that
already exists for open tabs. Small enough to send whole — the reference memory
has 14 people and 52 entities.

**Do not invent a schema.** Read what is there and degrade: a store with no
frontmatter still yields subjects, they just have no type. `index.md`,
`AGENTS.md` and `USER.md` are excluded by name.

## The `@` trigger

Structurally the same as `/` (§43), whose machinery is worth reusing:
`Composer.tsx` watches the input and `SlashMenu.tsx` filters
prefix-then-substring and owns the keyboard. An `@` at a word boundary opens the
same menu shape over subjects instead of commands, grouped by type, with the
one-line summary as secondary text.

**What lands in the message is literal text — `@gio-choi` — not a hidden
attachment.** Same reasoning as comment matchers (§17): text survives editing,
copy-paste, reload, and being read by something that is not this app. The server
re-resolves mentions against the index when the turn is sent, and a mention that
no longer resolves degrades to the words the user typed.

In the transcript a resolved mention renders as a pill — the §51 machinery
already does this, with `data-kind="person"` — and clicking it opens the memory
page in a tab, which works today because memory dirs are roots.

## Open questions

* **Does an unresolved `@name` still get a pointer?** Probably yes, of a
  different shape: *the user mentioned "@joshua"; there is no page under that
  name — search the store before assuming there is nothing.* A missing page is
  not the same as a missing person, and this is exactly the case where the agent
  should look around.
* **Does `@` also point at files and sessions?** The trigger is a natural home
  for "point at a thing", and §51 already resolves paths. Tempting, probably
  right eventually, but it turns the menu into a mixed bag. Keep `@` for memory
  subjects until the narrower thing has earned it.
* **Should a mention nudge the agent to write back?** When a conversation
  establishes something new about a mentioned person, a writable store (§50)
  could take it. Out of scope here, and it should never be automatic.

## Deferred: talking *as* someone

An earlier draft of this had a second mode where the agent answered *as* the
mentioned person, from their page. Set aside — the pointer is the useful part
and this is a much larger feature with its own problems. If it comes back, the
constraint that mattered: these pages describe real people observed from the
user's own screen, so a persona would have to answer from recorded facts with
the evidence citations the format already carries, admit gaps instead of filling
them, stay labelled as a simulation in the model-facing text and not only in the
CSS, and never write to memory whatever the directory's `writable` flag says.
