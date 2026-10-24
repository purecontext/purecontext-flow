# @purecontext/flow

A deterministic workflow state machine for agent sessions. The graph lives in a JSON file in the repo, every state change goes through one MCP tool, and the log records what happened and why.

Built for Claude Code plugins: an agent asks `flow_check` what it may do next, does it, then calls `flow_transition`. The engine refuses anything the graph does not allow, so a skill can never skip a step or invent a state.

## Install

```sh
npm install @purecontext/flow
```

Node 20 or later. One dependency: `@modelcontextprotocol/sdk`.

## Run

```json
{
  "mcpServers": {
    "flow": {
      "command": "npx",
      "args": ["-y", "@purecontext/flow", "--root", "${CLAUDE_PROJECT_DIR}"]
    }
  }
}
```

Or from a script: `import { createEngine, serveStdio } from '@purecontext/flow'`.

```
purecontext-flow [options]
purecontext-flow --validate [--workflow <path>]

  --root <dir>          project root; relative paths resolve here (FLOW_ROOT). Default: cwd
  --workflow <path>     workflow file (FLOW_WORKFLOW). Default: .forge/workflow.json
  --state-file <path>   state file, relative to the project directory (FLOW_STATE_FILE). Default: .forge/dev-state.json
  --log-file <path>     transition log (FLOW_LOG_FILE). Default: .forge/flow-log.jsonl
  --state-field <name>  field that holds the state (FLOW_STATE_FIELD). Default: workflow_state
```

Precedence: flag, then `FLOW_*` variable, then the workflow's own `config` block, then the default. State and workflow files are written via a temp file and rename. `FLOW_PROJECT_PATH` is accepted as an older name for `FLOW_ROOT`.

A missing or invalid workflow does not crash the server. Every tool call returns the same error, so the agent reads it and fixes the file.

## The workflow file

```json
{
  "$schema": "https://github.com/purecontext/purecontext-flow/schema/workflow.schema.json",
  "name": "build-lifecycle",
  "initial_state": "idle",
  "states": {
    "idle": {
      "description": "No active task.",
      "transitions": [{ "event": "task-picked", "target": "implementing", "action": "/next" }]
    },
    "implementing": {
      "transitions": [{ "event": "done", "target": "in-review", "action": null }]
    },
    "in-review": {
      "triggers": [
        { "condition": "session_counters.review_rounds >= thresholds.max_review_rounds", "target": "escalated", "action": null }
      ],
      "transitions": [
        { "event": "approved", "target": "idle", "action": "/merged" },
        { "event": "changes-requested", "target": "implementing", "action": "/iterate", "judgment": true }
      ]
    },
    "escalated": { "transitions": [{ "event": "resolved", "target": "idle", "action": null }] }
  },
  "thresholds": { "max_review_rounds": 3 },
  "global_actions": ["/help"]
}
```

| Key | Meaning |
|---|---|
| `states.<name>.transitions[]` | `event` moves to `target`; `action` is the command the agent should run next; `judgment: true` marks a choice the agent has to evaluate. |
| `states.<name>.triggers[]` | Automatic transitions. `condition` is `always`, or `<path> <op> <path\|number>` where paths are dotted lookups into the `flow_check` context and `thresholds.*` reads the workflow's thresholds. A counter missing from an existing object (e.g. `session_counters`) reads as 0; a path whose parent is missing is unresolvable and never fires; a `thresholds.*` key the workflow does not define is a load error. |
| `global_transitions[]` | Available from every state not in `except`. A state's own event with the same name wins. |
| `initial_state` | What a project is in before its state file has a state. `flow_transition` creates the file on the first event. |
| `resumption_targets` | For a transition with `"target": null`: the state to enter, looked up by the previous state. Used for "new session, pick up where we were". |
| `config` | `state_file`, `log_file`, `state_field`, `previous_state_field`. Relative paths resolve against the project directory. |

The engine validates the file on load: every target and `except` entry names a real state, every condition parses, thresholds are numbers, `initial_state` and `resumption_targets` point at states. `--validate` runs the same check from the shell. `schema/workflow.schema.json` gives editors completion.

## Fragments

A workflow can be composed from pieces. Beside the workflow file, every `*.json` in `workflow.d/` is a fragment, merged into it in filename order at load time:

```
.forge/
├── workflow.json           ← the base (optional when fragments exist)
└── workflow.d/
    ├── build.json          ← one plugin's states
    └── planning.json       ← another plugin's states
```

A fragment has the same shape as a workflow, minus `config`. It can add states, add transitions and triggers to states another piece defines, and contribute global transitions, global actions, thresholds and resumption targets. Pieces accumulate; they never override: two pieces defining the same event on one state, the same threshold with different values, different initial states, or the same global event is a load error that names both files. The first piece to define a state owns its description. The merged graph is validated like a single file, so a fragment may target a state another fragment defines; the handoff states (often just `idle`) are the contract between them.

This is how several plugins share one lifecycle without any of them knowing the others' states: each ships its fragment, an installer copies it into `workflow.d/`, and removing the plugin takes its states with it. `flow_modify` edits the base file only and refuses, naming the fragment, when asked to change a state, event or threshold a fragment owns. `--validate` reports the fragment count.

## Tools

| Tool | Does |
|---|---|
| `flow_check` | What can happen next: an `auto_action` when a trigger fires, otherwise the valid `options`. Reads the state file when `workflow_state` is omitted. |
| `flow_transition` | Applies an event. Validates it, writes the new state and the previous state to the state file in one write along with any `state_updates`, and logs it. The only way state changes. |
| `flow_explain` | Shortest path between two states, or everything reachable from one. |
| `flow_history` | Query the log: recent entries, filtered entries, or a summary that flags judgments which always resolve the same way. |
| `flow_modify` | Guided edits to the workflow file with a preview step. Refuses a change that would leave the file invalid; on confirm the server loads the new graph without a restart. Rewrites the file as 2-space JSON. |

### Many projects under one root

`flow_check` and `flow_transition` take an optional `project_path`. The state file is then resolved under that directory instead of the root, with the log staying at the root. A planning workbench with `projects/<name>/state.json` sets `"config": { "state_file": "state.json" }` and passes `project_path: "projects/<name>"`.

## Develop

```sh
pnpm install
pnpm check      # biome, tsc, node:test
```

Tests run against `dist/`, over the real CLI where the behavior is the stdio surface.
