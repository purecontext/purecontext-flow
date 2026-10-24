#!/usr/bin/env node
// stdout is the MCP channel: everything the CLI itself says goes to stderr.
import { readFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createEngine } from './engine.js'
import { serveStdio } from './server.js'

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }

const HELP = `purecontext-flow ${pkg.version}

Serve a workflow state machine over MCP (stdio).

  purecontext-flow [options]
  purecontext-flow --validate [--workflow <path>]

Options (each also reads the FLOW_* variable in parentheses):
  --root <dir>             project root; relative paths resolve here (FLOW_ROOT, or FLOW_PROJECT_PATH). Default: cwd
  --workflow <path>        workflow file (FLOW_WORKFLOW). Default: .forge/workflow.json
  --state-file <path>      state file, relative to the project directory (FLOW_STATE_FILE). Default: .forge/dev-state.json
  --log-file <path>        transition log (FLOW_LOG_FILE). Default: .forge/flow-log.jsonl
  --state-field <name>     field holding the state (FLOW_STATE_FIELD). Default: workflow_state
  --validate               check the workflow file and exit
  --help, --version

The workflow's own "config" block ({ state_file, log_file, state_field, previous_state_field })
applies when neither a flag nor a variable sets the value.
`

const { values } = parseArgs({
  options: {
    root: { type: 'string' },
    workflow: { type: 'string' },
    'state-file': { type: 'string' },
    'log-file': { type: 'string' },
    'state-field': { type: 'string' },
    validate: { type: 'boolean' },
    help: { type: 'boolean' },
    version: { type: 'boolean' },
  },
  strict: true,
})

if (values.help) {
  process.stderr.write(HELP)
  process.exit(0)
}
if (values.version) {
  process.stdout.write(`${pkg.version}\n`)
  process.exit(0)
}

const options = {
  root: values.root,
  workflow: values.workflow,
  stateFile: values['state-file'],
  logFile: values['log-file'],
  stateField: values['state-field'],
}

if (values.validate) {
  try {
    const engine = createEngine(options)
    const { fragments } = engine.sources
    const count = fragments.length ? `, ${fragments.length} fragment${fragments.length === 1 ? '' : 's'}` : ''
    process.stderr.write(`${engine.config.workflowPath}: valid (${engine.graph.stateNames().length} states${count})\n`)
    process.exit(0)
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`)
    process.exit(1)
  }
}

// Stay up on a bad or missing workflow: every tool call then returns the same
// error, which the agent can read and act on. A crashed server only shows as
// a failed MCP connection.
let engine = null
let startupError: string | undefined
try {
  engine = createEngine(options)
} catch (err) {
  startupError = (err as Error).message
  process.stderr.write(`purecontext-flow: ${startupError}\n`)
}
await serveStdio(engine, { version: pkg.version, startupError, start: () => createEngine(options) })
