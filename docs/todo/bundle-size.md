# Web bundle is one 837 kB chunk

CodeMirror and its grammars dominate. Lazy-load the editor until a file tab is
opened, and split the language modes, before worrying about anything else.
