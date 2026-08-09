# MCP streamable-HTTP transport is unverified

`mcp/manager.ts` supports stdio and streamable HTTP. Only stdio has been
exercised end to end. The HTTP path needs a real server behind it, plus a
decision about auth headers beyond the static `headers` map in the workspace
file.
