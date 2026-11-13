---
paths:
  - "src/tools/**"
---
# Tool Schema Follows The Handler

When an edit changes what a handler in `src/tools/` reads, writes, ignores or returns, rewrite every `description` in that file's `schema` that states the old behavior in the same edit, each parameter's included, not only the tool's top-level line. Agents calling the MCP tool read the schema and nothing else, so a stale parameter description hands every fleet skill a wrong contract; the README and CHANGELOG get updated by habit, and the parameter descriptions are what lag.
