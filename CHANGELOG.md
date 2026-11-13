# Changelog

## 0.3.0

- **`flow_update`.** Writes fields to the state file without a state change, in one atomic write, logged as an `update` entry (`flow_history` filters on it). Shallow like `state_updates`; the state and previous-state fields are refused. Skills that hand-edited the state file to bump a counter or record a PR number have a tool for it now. Exported as `flowUpdate`.
- **Refusals name dropped fields.** A `flow_transition` that writes nothing (invalid event, unknown state, unresolvable resumption, unreadable or unwritable file) returns the `state_updates` it was given as `dropped_state_updates`, with a note to re-send them, so a refused event no longer loses them silently.
- **Triggers read the state file.** `flow_check` evaluates triggers against the state file's fields with `context` laid over them, whether the state came from the file or from `workflow_state`. A counter a skill wrote (`session_counters.review_rounds`) now fires its trigger without the caller passing it; before, only caller-passed context was read and such triggers never fired. A state file it cannot read beside an explicit `workflow_state` is reported as `state_file_error`, not fatal. The trigger log entry names the file it read and the values the condition's paths resolved to (`values`). A state file field named `thresholds` is ignored, so no write can lift a cap. A project whose state file already holds a counter at its threshold sees the `auto_action` on its next check.

## 0.2.0

- **Fragments.** The engine merges every `workflow.d/*.json` beside the workflow file into it at load, in filename order. Fragments add states, transitions, triggers, global transitions, actions, thresholds and resumption targets; a collision (a state defined twice, the same event on one state, a threshold with a different value, a different initial state, the same global event) is a load error naming both files, never last-wins; the merged graph is validated as one. The base file is optional when fragments exist. `flow_modify` edits the base only and refuses what a fragment owns. `--validate` reports the fragment count. New exports: `loadWorkflowSources`, `composeWorkflow`, `mergeWorkflows`, `parseFragment`, `validateFragment`, `fragmentPaths`, `fragmentsDir`; `Engine` carries `sources` and `origin`.
- **Lazy start.** `createServer` takes a `start` function and tries it on every call while no engine is running, so a workflow created after the server came up is served without a restart. The CLI passes it. The missing-workflow message no longer says to restart.

## 0.1.1

- Review follow-ups: the transition error path does not resolve the state file twice.

## 0.1.0

- First release: the workflow state machine, five MCP tools, CLI.
