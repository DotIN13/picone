# Smaller things

- **Session eviction vs. tabs.** The server keeps the four most recent idle
  sessions loaded (`App.evictIdleSessions`). With more session tabs open than
  that, switching to an evicted one silently rebuilds it from its Pi session
  file. Correct, but slower than it looks; consider raising the cap or showing
  the reload.
- **`dist/` and other build output appear in the file tree.** `HIDDEN_DIRS` in
  `files/browser.ts` covers `node_modules` and friends but not build directories.
- **Comment re-anchoring is deliberately absent** (DESIGN §17). If matcher text
  drifts far enough that the agent cannot find it, the comment is still readable
  but no longer points anywhere. Revisit only if it bites in practice.
