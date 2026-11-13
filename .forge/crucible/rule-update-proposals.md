# Rule Update Proposals

Written by `/crucible:review` when a learned regression recurs in a second PR; `/crucible:promote-rule` reads only this file.

## convention-tool-schema-follows-handler
- **Proposed:** 2026-11-13
- **Status:** accepted (2026-11-13)
- **Kind:** rule
- **Pattern observed in:** PR #2 round 1, PR #5 round 1
- **Proposed rule text:**
  > # Tool Schema Follows The Handler
  >
  > When an edit changes what a handler in `src/tools/` reads, writes, ignores or returns, rewrite every `description` in that file's `schema` that states the old behavior in the same edit, each parameter's included, not only the tool's top-level line. Agents calling the MCP tool read the schema and nothing else, so a stale parameter description hands every fleet skill a wrong contract; the README and CHANGELOG get updated by habit, and the parameter descriptions are what lag.
- **Reasoning:** Both occurrences updated README, CHANGELOG and the tool's top-level description and left one parameter description stating the old behavior (widened in #2, narrowed in #5). A rule, not a gate: no script can tell which description sentence a behavior change falsifies. Scoped to `src/tools/**`, where the schema and its handler share a file.
- **Recommended location:** `.claude/rules/convention-tool-schema-follows-handler.md`
- **Promoted to:** /Users/jeffreese/Code/purecontext-flow/.claude/rules/convention-tool-schema-follows-handler.md
