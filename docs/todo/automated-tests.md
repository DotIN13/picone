# No automated tests

Everything so far was verified by driving the running app — an end-to-end script
plus browser interaction — and nothing is committed. The highest-value first
targets, because they are pure functions with real edge cases:

- `permissions/policy.ts` — `classifyShellCommand`, especially the git split and
  the argument-shape fallback that catches non-`bash` shell tools.
- `workspace/schema.ts` — validation errors and defaults.
- `comments/matcher.ts` and `lib/selection.ts` — `findLineRange` fuzzy matching.
- `pi/events.ts` — Pi event → protocol event translation.

Then one integration test that boots the server against a temp workspace and
walks prompt → tool call → permission → comment, with a stub model.
