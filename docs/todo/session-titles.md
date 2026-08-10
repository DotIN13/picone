# Sessions are all called "New session"

Pi exposes a session *name* and never generates one — `setSessionName` is the
whole API, and Pi's own session selector falls back to `session.name ??
session.firstMessage`. Picone now keeps that name in sync in both directions
(§26), which means a name set anywhere is visible everywhere. It does not mean
sessions have names.

Two ways to fill the slot, and they compose:

* **The first user message, truncated.** Free, instant, no model call, and what
  Pi itself falls back to. "Reply with exactly the word ALPHA…" is a poor title
  and an enormous improvement on "New session". This is the floor.
* **A generated title** after the first exchange — one cheap call, a handful of
  tokens, the way most chat apps do it. Nicer titles, at the cost of a request
  per session and a working model, and it has to not fight a name the user set
  by hand.

Worth doing in that order. A title that appears instantly and never moves is
calmer than one that rewrites itself a few seconds in, and the first option
works with no model configured at all — which is the state a session is in
when its model 404s.

Whatever generates it should write through `setSessionName` like everything
else, so the name reaches the session file rather than living only in Picone's
table.
