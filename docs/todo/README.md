# Known gaps

One file per piece of outstanding work, ordered here by value rather than by
filename — so finishing one never renumbers the rest.

| | |
|---|---|
| [Thin test coverage](automated-tests.md) | only the reference detector has tests; the rest is verified by hand |
| [Web bundle is one 870 kB chunk](bundle-size.md) | CodeMirror loads whether or not a file is opened |
| [MCP streamable-HTTP is unverified](mcp-http-transport.md) | written from the spec, exercised only over stdio |
| [Server logs go nowhere](server-logging.md) | stdout only, lost when the terminal closes |
| [Branches are invisible](branch-switching.md) | rewinding keeps the old path, but nothing can navigate back to it |
| [Smaller things](smaller-things.md) | the ones too small to deserve a page each |

## How this works

**Done work leaves.** When something here lands, its substance moves into
[DESIGN.md](../DESIGN.md) — where the design of the thing that now exists
belongs — and the file is deleted. A finished item struck through in a to-do
list is a to-do list slowly turning into a changelog; git already keeps the
history, and the design doc should read as a description of what is built, not
as a record of the order it was built in.

What graduates is the *design*, not the diary: what the thing does, why it is
shaped that way, and the traps found on the way. What was hard on a Tuesday is
what commit messages are for.

**Nothing is numbered.** A file is named for what it is. The ordering above is a
judgement that changes more often than the work does, and keeping it in one
place means changing it costs one line.
