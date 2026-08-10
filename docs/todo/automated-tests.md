# Thin test coverage

`npm test` runs `node --test` over both workspaces. It currently covers the pure
halves of two features: `lib/references.ts` and `lib/fences.ts` for media
previews (§51) — path heuristics, punctuation trimming, and what every *prefix*
of a streaming message produces — and `memory/subjects.ts` for mentions (§52),
where the load-bearing assertion is that the pointer block never contains the
page.

Everything else is still verified by driving the running app. The remaining
high-value targets, because they are pure functions with real edge cases:

- `permissions/policy.ts` — `classifyShellCommand`, especially the git split and
  the argument-shape fallback that catches non-`bash` shell tools.
- `workspace/schema.ts` — validation errors and defaults.
- `comments/matcher.ts` and `lib/selection.ts` — `findLineRange` fuzzy matching.
- `files/resolve.ts` — root ordering, traversal refusal, and the miss path.
- `memory/subjects.ts` — the frontmatter reader and the folder-type fallback.
- `pi/events.ts` — Pi event → protocol event translation.

Then one integration test that boots the server against a temp workspace and
walks prompt → tool call → permission → comment, with a stub model.
