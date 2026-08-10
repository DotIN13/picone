# Web bundle is one 870 kB chunk

CodeMirror and its grammars dominate: `@codemirror/view` alone is 479 kB of
source in the entry chunk, and the lezer grammars add another 280 kB. Lazy-load
the editor until a file tab is opened, and split the language modes, before
worrying about anything else.

Mermaid is *not* part of this. It is dynamically imported and lands in its own
chunks (§51), so a session that never shows a diagram never fetches it.
