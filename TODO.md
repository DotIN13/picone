# TODO

Known gaps, roughly in order of value.

---

## ~~1. Extension UI protocol in the browser~~ — done

Implemented. `apps/server/src/pi/extension-ui.ts` provides a real
`ExtensionUIContext` over the WebSocket, mirroring what `runRpcMode` does over
stdio: `select`, `confirm`, `input`, and `editor` park a promise and resolve on
the browser's answer (honouring `timeout` and `signal`); `notify`, `setStatus`,
`setWidget`, `setTitle`, and `setEditorText` drive chat notices, a title-bar
pill, monospace blocks around the composer, the tab label, and the composer
itself. `getEditorText()` reads a debounced mirror of the composer. `mode` is
now `"rpc"`, so `ctx.hasUI` is true and extensions offer their dialogs.

Two things the original write-up got wrong, both found by building it:

- **The blocker was never the UI context.** `/subagent-cost` renders through
  `pi.sendMessage({ display: true })`, which arrives as a `message_end` event
  with `role: "custom"` — nothing to do with `ctx.ui`. Those now get their own
  transcript row. This is what actually fixed the motivating case.
- **Every member of `ExtensionUIContext` must exist**, even the terminal-only
  ones. A missing method is not graceful degradation: the extension dies with
  `ctx.ui.x is not a function` and its whole command fails. `/subagents-models`
  broke exactly this way on `setToolsExpanded`.

Still not supported, and probably not worth it:

- Component-factory widgets, custom message *renderers*, custom overlays, and
  `pi.registerShortcut` keybindings. All are TUI-component-shaped; RPC mode
  drops them too.
- `ui.custom()` and `ui.overlay()` return `undefined`.
- Theme methods are inert — Picone owns its own theming.

---

## 1b. Reference: the extension UI surface

The nine methods and their web mappings, kept here because the mapping is not
obvious from Pi's types alone.

Four block until the human answers:

| method | request fields | response |
|---|---|---|
| `select` | `title`, `options[]`, `timeout?` | `{ value }` or `{ cancelled }` |
| `confirm` | `title`, `message`, `timeout?` | `{ confirmed }` |
| `input` | `title`, `placeholder?`, `timeout?` | `{ value }` or `{ cancelled }` |
| `editor` | `title`, `prefill?` | `{ value }` or `{ cancelled }` |

Five are fire-and-forget:

| method | web mapping |
|---|---|
| `notify` | chat notice, at info / warn / error |
| `setStatus` | pill in the title bar; `undefined` clears it |
| `setWidget` | monospace block above or below the composer |
| `setTitle` | session tab label |
| `setEditorText` / `pasteToEditor` | composer contents |

Timeout and abort resolve to the caller's default rather than rejecting, and the
server emits `extension.ui.prompt.closed` so the browser dismisses the dialog.
Pi's reference implementation is `dist/modes/rpc/rpc-mode.js`; the TUI client
equivalent is `examples/rpc-extension-ui.ts`.

To exercise all of it, drop an extension in `.pi/extensions/` that registers one
command per method — that is how this was verified.

---

## 2. Rich previews for media referenced in the flow

**Goal.** When the agent's output mentions something viewable — an image it just
wrote, a Mermaid diagram, a URL, a file path, a diff — show it inline instead of
leaving a bare string the user has to go find. Small things become **pills**;
substantial things become **preview boxes**.

Today the transcript renders markdown and nothing else: an image path is grey
text, a Mermaid block is unhighlighted code, a URL is a link.

### What to detect

| kind | source | treatment |
|---|---|---|
| image | markdown `![]()`, or a path/URL ending `.png .jpg .jpeg .gif .webp .avif .svg` | preview box, click to open full size |
| mermaid | fenced ` ```mermaid ` | rendered diagram, toggle to source |
| file | a path inside a workspace root | pill with file icon + basename, click opens a tab |
| directory | ditto, resolving to a directory | pill, click reveals in the sidebar tree |
| webpage | `http(s)://` | pill with favicon + hostname; optional card on hover |
| diff / patch | fenced `diff`, or `edit`/`write` tool patches | already handled for tool calls; reuse for fenced blocks |
| audio / video | `.mp3 .wav .m4a .mp4 .webm` | inline player, lazily loaded |
| pdf | `.pdf` | pill; a preview needs a renderer, so probably out of scope |
| csv / json | small data files | pill that expands to a table or a folded tree |

### Where the work goes

1. **A detector**, `apps/web/src/lib/media.ts` (or a sibling — `media.ts` is
   taken by the responsive helpers, so name it `references.ts`). Pure function:
   markdown source in, a list of `{ kind, raw, resolved, range }` out. Pure means
   it is unit-testable, which matters more here than anywhere else in the app
   because the heuristics will need tuning.

2. **Path resolution is a server concern.** The browser cannot tell whether
   `src/auth.ts` exists, whether it is a file or a directory, or whether it is
   inside a workspace root. Add a batch endpoint:

   ```
   POST /api/files/resolve  { paths: string[] }
   →    { results: [{ path, exists, type, size, kind, mtime }] }
   ```

   Batch, because a single message can mention a dozen paths. Cache by
   `path + mtime` client-side. Reuse `resolveWithinRoots` so a mentioned path
   outside the workspace resolves to "not ours" and stays plain text.

3. **Serving bytes.** Images and media need a real URL. Add
   `GET /api/files/raw?path=…` behind the same root guard as `/api/files/read`,
   with correct `Content-Type`, `ETag`/`Last-Modified`, and range support for
   audio/video seeking. This is the one genuinely new server capability.

4. **Rendering.** A `<MediaReference>` component with a pill variant and a box
   variant, following the existing `data-component` / `data-slot` convention.
   Wire it into `Markdown.tsx` — which currently sets `innerHTML`, so this needs
   a real change: either post-process the sanitized DOM and hydrate reference
   nodes, or move to a token walk over `marked`'s AST. **The AST walk is the
   right call** — `innerHTML` plus DOM surgery will fight the sanitizer.

5. **Mermaid** is the one heavy dependency (~500 kB). It must be dynamically
   imported, only when a diagram is actually present, and rendered into a
   sandboxed container. Note that Pi bundles `grok-mermaid`; worth checking
   whether that is reusable before adding another copy.

### Design constraints

- **Never fetch what was not asked for.** A URL pill shows hostname and favicon
  from a local cache; it must not phone the page for a title card unless the
  user opts in. Silent outbound requests from a local-first tool are a
  surprise, and would leak which links appear in a private transcript.
- **Previews are lazy.** `IntersectionObserver` — a long transcript should not
  decode fifty images.
- **Streaming-safe.** Detection runs on partial markdown while a message
  streams. A half-written `![alt](pa` must not flicker a broken image; only
  detect on complete constructs, and re-scan on `assistant.end`.
- **The same treatment belongs in file tabs**, not just chat. A markdown file
  full of image links should show them.
- **Respect the read-only rule** (DESIGN §13). A preview is a view, not an
  editor.

### Open questions

- Does a pill for every mentioned path become noise? Possibly only linkify paths
  that resolve *and* appear outside a code fence, with inline code getting a
  subtler treatment than prose.
- Should preview state (expanded/collapsed) persist in the transcript? Leaning
  no — recompute from the text, keep `messages` free of view state.
- SVG is an image and a script vector. Serve it with a restrictive
  `Content-Security-Policy` and render it in an `<img>`, never inline.

---

## 3. No automated tests

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

---

## 4. Web bundle is one 837 kB chunk

CodeMirror and its grammars dominate. Lazy-load the editor until a file tab is
opened, and split the language modes, before worrying about anything else.

---

## 5. MCP streamable-HTTP transport is unverified

`mcp/manager.ts` supports stdio and streamable HTTP. Only stdio has been
exercised end to end. The HTTP path needs a real server behind it, plus a
decision about auth headers beyond the static `headers` map in the workspace
file.

---

## 6. Server logs go nowhere

`[picone] …` is stdout only — no file, no rotation, no request log. Fine for
`npm start > picone.log`, thin for anything else.

---

## 7. Smaller things

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
