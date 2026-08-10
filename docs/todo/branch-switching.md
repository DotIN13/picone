# Branches are invisible

Rewinding (§53) leaves the abandoned path in the session file as a sibling
branch, and Picone has no way to look at it or go back to it. Today a rewind
prints one notice saying the messages are still there, which is honest but not
much use.

What is missing:

* **A marker where the conversation diverged**, with a count and a way to switch.
  The cheapest useful version: on the message whose entry has more than one
  child, show "2 branches" and let the user pick. `getChildren(parentId)` and
  `getBranch(fromId)` already provide everything needed.
* **A tree view** in the sidebar's Sessions section, for sessions that have been
  rewound more than once or twice.
* **Branch summaries.** `navigateTree` takes `{ summarize: true }` and spends a
  model call describing what was abandoned, attaching it as a `branch_summary`
  entry. Worth offering when rewinding past real work, pure cost when fixing a
  typo — so it needs a choice in the UI, and `branch_summary` needs a `ChatItem`
  kind or it renders as nothing.

Switching branches also has to move Picone's own transcript, which is truncated
on rewind rather than kept per-branch. Either it is rebuilt from Pi's entries on
a switch — losing the items Pi never saw, like permission cards — or the
`messages` table grows a branch column. The second is more faithful and more
work.
