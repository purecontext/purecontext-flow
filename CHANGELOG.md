# Changelog

## 0.2.0

- **Fragments.** The engine merges every `workflow.d/*.json` beside the workflow file into it at load, in filename order. Fragments add states, transitions, triggers, global transitions, actions, thresholds and resumption targets; a collision (a state defined twice, the same event on one state, a threshold with a different value, a different initial state, the same global event) is a load error naming both files, never last-wins; the merged graph is validated as one. The base file is optional when fragments exist. `flow_modify` edits the base only and refuses what a fragment owns. `--validate` reports the fragment count. New exports: `loadWorkflowSources`, `composeWorkflow`, `mergeWorkflows`, `parseFragment`, `validateFragment`, `fragmentPaths`, `fragmentsDir`; `Engine` carries `sources` and `origin`.
- **Lazy start.** `createServer` takes a `start` function and tries it on every call while no engine is running, so a workflow created after the server came up is served without a restart. The CLI passes it. The missing-workflow message no longer says to restart.

## 0.1.1

- Review follow-ups: the transition error path does not resolve the state file twice.

## 0.1.0

- First release: the workflow state machine, five MCP tools, CLI.
