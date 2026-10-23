import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import {
  WorkflowError,
  createEngine,
  flowCheck,
  flowExplain,
  flowHistory,
  flowModify,
  flowTransition,
  resolveConfig,
} from '../dist/index.js'
import { project, workflow } from './fixture.mjs'

const engineFor = (root, extra = {}) => createEngine({ root, env: {}, ...extra })
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))

test('config precedence: explicit, then FLOW_* env, then the workflow config block, then defaults', () => {
  const root = project({
    workflow: { ...workflow(), config: { state_file: 'state.json', log_file: 'log/flow.jsonl', state_field: 'phase' } },
  })
  const fromWorkflow = engineFor(root).config
  assert.equal(fromWorkflow.stateFile, 'state.json')
  assert.equal(fromWorkflow.logFile, join(root, 'log/flow.jsonl'))
  assert.equal(fromWorkflow.stateField, 'phase')
  assert.equal(fromWorkflow.previousStateField, 'previous_phase')

  const fromEnv = engineFor(root, {
    env: { FLOW_STATE_FILE: 'env-state.json', FLOW_LOG_FILE: 'env.jsonl', FLOW_STATE_FIELD: 'st' },
  }).config
  assert.equal(fromEnv.stateFile, 'env-state.json')
  assert.equal(fromEnv.logFile, join(root, 'env.jsonl'))
  assert.equal(fromEnv.previousStateField, 'previous_st')

  const explicit = engineFor(root, {
    env: { FLOW_STATE_FILE: 'env-state.json' },
    stateFile: 'x.json',
    previousStateField: 'was',
  }).config
  assert.equal(explicit.stateFile, 'x.json')
  assert.equal(explicit.previousStateField, 'was')

  const defaults = resolveConfig({ root: '/r', env: {} })
  assert.deepEqual(defaults, {
    root: '/r',
    workflowPath: '/r/.forge/workflow.json',
    stateFile: '.forge/dev-state.json',
    logFile: '/r/.forge/flow-log.jsonl',
    stateField: 'workflow_state',
    previousStateField: 'previous_workflow_state',
  })
  assert.equal(
    resolveConfig({ env: { FLOW_PROJECT_PATH: '/legacy' } }).root,
    '/legacy',
    'FLOW_PROJECT_PATH still names the root',
  )
  assert.equal(resolveConfig({ env: { FLOW_ROOT: '/new', FLOW_PROJECT_PATH: '/legacy' } }).root, '/new')
})

test('a missing or invalid workflow is a WorkflowError that names the file', () => {
  const root = project()
  assert.throws(
    () => engineFor(root, { workflow: 'nope.json' }),
    (err) => err instanceof WorkflowError && err.message.includes(join(root, 'nope.json')),
  )
  writeFileSync(join(root, '.forge/workflow.json'), '{ not json')
  assert.throws(() => engineFor(root), /not valid JSON/)
  writeFileSync(
    join(root, '.forge/workflow.json'),
    JSON.stringify({ states: { a: { transitions: [{ event: 'x', target: 'b' }] } } }),
  )
  assert.throws(
    () => engineFor(root),
    (err) => err.issues?.length === 1 && /unknown state "b"/.test(err.issues[0]),
  )
})

test('flow_check: options, a firing trigger, and an unknown state', () => {
  const engine = engineFor(project())
  const idle = flowCheck.handler(engine, { workflow_state: 'idle' })
  assert.equal(idle.auto_action, null)
  assert.deepEqual(
    idle.options.map((o) => [o.event, o.target, o.global]),
    [
      ['task-picked', 'implementing', false],
      ['stop', 'cleared', true],
    ],
  )
  assert.deepEqual(idle.global_actions, ['/help'])

  const review = flowCheck.handler(engine, {
    workflow_state: 'in-review',
    context: { session_counters: { review_rounds: 3 } },
  })
  assert.equal(review.auto_action.target, 'escalated')
  assert.equal(review.auto_action.trigger_condition, 'session_counters.review_rounds >= thresholds.max_review_rounds')
  assert.deepEqual(review.options, [])
  assert.equal(engine.history().filter((e) => e.type === 'trigger').length, 1, 'a fired trigger is logged')

  const judged = flowCheck.handler(engine, {
    workflow_state: 'in-review',
    context: { session_counters: { review_rounds: 1 } },
  })
  assert.equal(judged.options.find((o) => o.event === 'changes-requested').judgment, true)

  const bad = flowCheck.handler(engine, { workflow_state: 'limbo' })
  assert.match(bad.error, /Unknown state/)
  assert.ok(bad.valid_states.includes('idle'))
})

test('a trigger that reads an undefined threshold is a load error', () => {
  const w = workflow()
  w.states['in-review'].triggers[0].condition = 'session_counters.review_rounds >= thresholds.nope'
  assert.throws(
    () => engineFor(project({ workflow: w })),
    (err) => /reads thresholds\.nope, which the workflow does not define/.test(err.message),
  )
})

test('state and workflow writes leave no temp file behind and never share one absolute state file across projects', () => {
  const root = project({ state: { workflow_state: 'idle' } })
  const engine = engineFor(root)
  flowTransition.handler(engine, { event: 'task-picked' })
  flowModify.handler(engine, {
    operation: 'update_threshold',
    threshold_key: 'max_review_rounds',
    threshold_value: 4,
    confirm: true,
  })
  const leftovers = readdirSync(join(root, '.forge')).filter((f) => f.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
  assert.equal(engine.graph.thresholds().max_review_rounds, 4, 'the running engine loaded the new graph')

  const shared = engineFor(root, { stateFile: join(root, 'one-state.json') })
  const result = flowTransition.handler(shared, { event: 'task-picked', project_path: 'projects/a' })
  assert.match(result.error, /cannot be used with the absolute state file/)
  assert.match(
    flowCheck.handler(shared, { project_path: 'projects/a' }).error,
    /cannot be used with the absolute state file/,
  )
})

test('log entries name the state file they concern', () => {
  const root = project({ workflow: { ...workflow(), config: { state_file: 'state.json' } } })
  mkdirSync(join(root, 'projects/a'), { recursive: true })
  writeFileSync(join(root, 'projects/a/state.json'), JSON.stringify({ workflow_state: 'idle' }))
  const engine = engineFor(root)
  flowTransition.handler(engine, {
    event: 'task-picked',
    project_path: 'projects/a',
    judgment: { condition: 'c', result: true },
  })
  flowCheck.handler(engine, { workflow_state: 'in-review', context: { session_counters: { review_rounds: 3 } } })
  const [transition, judgment, trigger] = engine.history()
  assert.equal(transition.state_path, join(root, 'projects/a/state.json'))
  assert.equal(judgment.state_path, join(root, 'projects/a/state.json'))
  assert.equal(trigger.state_path, null, 'a check with an explicit state read no file')
})

test('flow_check: resumption from context, and from the state file when the state is omitted', () => {
  const root = project({ state: { workflow_state: 'cleared', previous_workflow_state: 'implementing' } })
  const engine = engineFor(root)
  const fromContext = flowCheck.handler(engine, {
    workflow_state: 'cleared',
    context: { previous_workflow_state: 'escalated' },
  })
  assert.equal(fromContext.resumption.resume_to, 'escalated')
  assert.equal(fromContext.options[0].event, 'resume')

  const fromFile = flowCheck.handler(engine, {})
  assert.equal(fromFile.state, 'cleared')
  assert.equal(fromFile.state_path, join(root, '.forge/dev-state.json'))
  assert.equal(fromFile.resumption.resume_to, 'implementing')

  const unresolved = flowCheck.handler(engine, { workflow_state: 'cleared' })
  assert.equal(unresolved.resumption, undefined)
  assert.equal(unresolved.options[0].target, null, 'without a previous state the null target is shown as-is')
})

test('flow_check with no state file reads initial_state, and errors without one', () => {
  const engine = engineFor(project())
  assert.equal(flowCheck.handler(engine, {}).state, 'idle')
  const w = workflow()
  w.initial_state = undefined
  const bare = engineFor(project({ workflow: w }))
  assert.match(flowCheck.handler(bare, {}).error, /no initial_state/)
})

test('flow_transition: a valid event writes both fields, merges updates, rejects reserved keys, and logs', () => {
  const root = project({ state: { workflow_state: 'idle', note: 'keep me' } })
  const engine = engineFor(root)
  const result = flowTransition.handler(engine, {
    event: 'task-picked',
    state_updates: { task: 'T-1', workflow_state: 'escalated', previous_workflow_state: 'x' },
    context: { who: 'test' },
    judgment: { condition: 'ready?', result: true, reasoning: 'yes' },
  })
  assert.equal(result.success, true)
  assert.equal(result.new_state, 'implementing')
  assert.equal(result.action, '/next')
  assert.deepEqual(result.ignored_state_updates, ['workflow_state', 'previous_workflow_state'])
  const state = readJson(join(root, '.forge/dev-state.json'))
  assert.deepEqual(state, {
    workflow_state: 'implementing',
    previous_workflow_state: 'idle',
    note: 'keep me',
    task: 'T-1',
  })
  const log = engine.history()
  assert.deepEqual(
    log.map((e) => e.type),
    ['transition', 'judgment'],
  )
  assert.equal(log[0].from_state, 'idle')
  assert.equal(log[0].to_state, 'implementing')
  assert.deepEqual(log[0].context, { who: 'test' })
  assert.equal(log[1].chosen_transition, 'implementing')
  assert.ok(log[0].timestamp)
})

test('flow_transition: invalid events name the valid ones and change nothing', () => {
  const root = project({ state: { workflow_state: 'idle' } })
  const engine = engineFor(root)
  const result = flowTransition.handler(engine, { event: 'approved' })
  assert.match(result.error, /not valid from state "idle"/)
  assert.deepEqual(result.valid_events, ['task-picked', 'stop'])
  assert.equal(readJson(join(root, '.forge/dev-state.json')).workflow_state, 'idle')
  assert.equal(existsSync(engine.config.logFile), false)
})

test('flow_transition: a global event works from any state outside its except list', () => {
  const root = project({ state: { workflow_state: 'implementing' } })
  const engine = engineFor(root)
  assert.equal(flowTransition.handler(engine, { event: 'stop' }).new_state, 'cleared')
  assert.match(flowTransition.handler(engine, { event: 'stop' }).error, /not valid from state "cleared"/)
})

test('flow_transition: a null target resolves through the previous state, or errors when it cannot', () => {
  const root = project({ state: { workflow_state: 'cleared', previous_workflow_state: 'in-review' } })
  const engine = engineFor(root)
  const result = flowTransition.handler(engine, { event: 'resume' })
  assert.equal(result.new_state, 'in-review')
  assert.match(result.description, /Resume from in-review/)
  assert.equal(readJson(join(root, '.forge/dev-state.json')).previous_workflow_state, 'cleared')

  const orphan = engineFor(project({ state: { workflow_state: 'cleared' } }))
  assert.match(flowTransition.handler(orphan, { event: 'resume' }).error, /has no resumption target/)
})

test('flow_transition: a missing state file starts from initial_state and is created', () => {
  const root = project()
  const engine = engineFor(root)
  const result = flowTransition.handler(engine, { event: 'task-picked' })
  assert.equal(result.initialized_from, 'initial_state')
  assert.equal(result.new_state, 'implementing')
  assert.deepEqual(readJson(join(root, '.forge/dev-state.json')), {
    previous_workflow_state: 'idle',
    workflow_state: 'implementing',
  })

  const w = workflow()
  w.initial_state = undefined
  const bare = engineFor(project({ workflow: w }))
  assert.match(
    flowTransition.handler(bare, { event: 'task-picked' }).error,
    /No state file at .* and the workflow has no initial_state/,
  )
})

test('flow_transition: project_path selects a state file under the root, with a custom state file name and field', () => {
  const root = project({
    workflow: { ...workflow(), config: { state_file: 'state.json', state_field: 'phase_state' } },
  })
  mkdirSync(join(root, 'projects/alpha'), { recursive: true })
  writeFileSync(join(root, 'projects/alpha/state.json'), JSON.stringify({ phase_state: 'idle', current_phase: 2 }))
  const engine = engineFor(root)
  const result = flowTransition.handler(engine, { project_path: 'projects/alpha', event: 'task-picked' })
  assert.equal(result.state_path, join(root, 'projects/alpha/state.json'))
  assert.deepEqual(readJson(result.state_path), {
    phase_state: 'implementing',
    previous_phase_state: 'idle',
    current_phase: 2,
  })
  assert.equal(flowCheck.handler(engine, { project_path: 'projects/alpha' }).state, 'implementing')
  assert.equal(
    readJson(join(root, 'projects/alpha/state.json')).workflow_state,
    undefined,
    'the default field name is not written',
  )
  assert.equal(engine.config.logFile, join(root, '.forge/flow-log.jsonl'), 'the log stays at the root')
})

test('flow_transition: a bad state in the file is reported, not applied', () => {
  const engine = engineFor(project({ state: { workflow_state: 'bogus' } }))
  const result = flowTransition.handler(engine, { event: 'task-picked' })
  assert.match(result.error, /Unknown state in .*: "bogus"/)
})

test('flow_history: recent, filter, since and summary', () => {
  const engine = engineFor(project({ state: { workflow_state: 'idle' } }))
  assert.equal(flowHistory.handler(engine, {}).total_entries, 0)
  flowTransition.handler(engine, { event: 'task-picked' })
  flowTransition.handler(engine, { event: 'done', judgment: { condition: 'tests pass', result: true } })
  flowTransition.handler(engine, { event: 'changes-requested', judgment: { condition: 'tests pass', result: true } })
  flowTransition.handler(engine, { event: 'done', judgment: { condition: 'tests pass', result: true } })
  const recent = flowHistory.handler(engine, { limit: 2 })
  assert.equal(recent.returned, 2)
  assert.equal(recent.entries[1].type, 'judgment')
  const transitions = flowHistory.handler(engine, { mode: 'filter', type: 'transition', state: 'implementing' })
  assert.deepEqual(
    transitions.entries.map((e) => e.event),
    ['done', 'done'],
  )
  assert.equal(flowHistory.handler(engine, { since: '2999-01-01T00:00:00Z' }).returned, 0)
  const summary = flowHistory.handler(engine, { mode: 'summary' })
  assert.deepEqual(summary.by_type, { transition: 4, judgment: 3 })
  assert.equal(summary.judgment_analysis.optimization_candidates[0].condition, 'tests pass')
  assert.equal(summary.judgment_analysis.optimization_candidates[0].always, 'true')
})

test('flow_explain: shortest path, reachability, and triggers as edges', () => {
  const engine = engineFor(project())
  const path = flowExplain.handler(engine, { from_state: 'idle', to_state: 'escalated' })
  assert.equal(path.found, true)
  assert.deepEqual(
    path.steps.map((s) => s.via),
    ['task-picked', 'done', 'trigger: session_counters.review_rounds >= thresholds.max_review_rounds'],
  )
  const all = flowExplain.handler(engine, { from_state: 'escalated' })
  assert.equal(all.reachable_count, 5)
  assert.equal(all.states[0].state, 'escalated')
  const none = flowExplain.handler(engine, { from_state: 'idle', to_state: 'escalated', max_depth: 1 })
  assert.equal(none.found, false)
  assert.match(flowExplain.handler(engine, { from_state: 'void' }).error, /Unknown state/)
})

test('flow_modify: previews do not write, confirms write the resolved workflow, invalid results are refused', () => {
  const root = project()
  const engine = engineFor(root, { env: { FLOW_WORKFLOW: '.forge/workflow.json' } })
  const wfPath = join(root, '.forge/workflow.json')
  const before = readFileSync(wfPath, 'utf8')

  const preview = flowModify.handler(engine, {
    operation: 'update_threshold',
    threshold_key: 'max_review_rounds',
    threshold_value: 5,
  })
  assert.equal(preview.preview, true)
  assert.deepEqual(preview.change, { threshold: 'max_review_rounds', old_value: 3, new_value: 5 })
  assert.equal(readFileSync(wfPath, 'utf8'), before)

  const applied = flowModify.handler(engine, {
    operation: 'update_threshold',
    threshold_key: 'max_review_rounds',
    threshold_value: 5,
    confirm: true,
  })
  assert.equal(applied.applied, true)
  assert.equal(applied.path, wfPath)
  assert.equal(readJson(wfPath).thresholds.max_review_rounds, 5)

  assert.equal(
    flowModify.handler(engine, {
      operation: 'add_state',
      state_name: 'parked',
      state_description: 'On hold',
      confirm: true,
    }).applied,
    true,
  )
  assert.equal(readJson(wfPath).states.parked.description, 'On hold')
  const fresh = engine
  assert.equal(
    flowModify.handler(fresh, {
      operation: 'add_transition',
      state_name: 'idle',
      transition: { event: 'park', target: 'parked' },
      confirm: true,
    }).applied,
    true,
  )
  assert.match(
    flowModify.handler(fresh, {
      operation: 'add_transition',
      state_name: 'idle',
      transition: { event: 'park', target: 'parked' },
    }).error,
    /already has an event/,
  )
  assert.match(
    flowModify.handler(engineFor(root), { operation: 'remove_state', state_name: 'parked' }).error,
    /referenced by idle → park/,
  )
  assert.match(
    flowModify.handler(fresh, { operation: 'remove_transition', state_name: 'idle', transition: { event: 'nope' } })
      .error,
    /No transition/,
  )
  assert.equal(
    flowModify.handler(engineFor(root), {
      operation: 'remove_transition',
      state_name: 'idle',
      transition: { event: 'park' },
      confirm: true,
    }).applied,
    true,
  )
  assert.equal(
    flowModify.handler(engineFor(root), { operation: 'remove_state', state_name: 'parked', confirm: true }).applied,
    true,
  )
  assert.equal(readJson(wfPath).states.parked, undefined)

  const trig = flowModify.handler(engineFor(root), {
    operation: 'add_trigger',
    state_name: 'idle',
    trigger: { condition: 'bad condition', target: 'idle' },
    confirm: true,
  })
  assert.match(trig.error, /would leave the workflow invalid/)
  assert.equal(readJson(wfPath).states.idle.triggers, undefined)

  const summary = flowModify.handler(engineFor(root), { operation: 'preview' })
  assert.equal(summary.total_states, 5)
  assert.equal(summary.path, wfPath)
})
