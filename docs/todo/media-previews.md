# Rich previews for media referenced in the flow

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
