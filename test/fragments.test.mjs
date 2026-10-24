import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { WorkflowError, createEngine, flowCheck, flowModify, flowTransition, mergeWorkflows } from '../dist/index.js'
import { project, workflow } from './fixture.mjs'

const engineFor = (root) => createEngine({ root, env: {} })
const fragment = (root, name, data) => {
  mkdirSync(join(root, '.forge', 'workflow.d'), { recursive: true })
  writeFileSync(join(root, '.forge', 'workflow.d', name), `${JSON.stringify(data, null, 2)}\n`)
}
/** A planning mode as a second plugin would ship it: its own state, entered from and returning to idle. */
const planning = () => ({
  name: 'planning',
  states: {
    idle: { transitions: [{ event: 'plan', target: 'planning', action: '/plan' }] },
    planning: {
      description: 'Intent docs being written',
      transitions: [{ event: 'plan-done', target: 'idle', action: '/done' }],
    },
  },
  resumption_targets: { planning: 'planning' },
})

test('a fragment adds a state and a transition out of a base state', () => {
  const root = project()
  fragment(root, 'planning.json', planning())
  const engine = engineFor(root)
  assert.deepEqual(engine.sources, {
    base: join(root, '.forge/workflow.json'),
    fragments: [join(root, '.forge/workflow.d/planning.json')],
  })
  assert.ok(engine.graph.state('planning'))
  const events = flowCheck.handler(engine, { workflow_state: 'idle' }).options.map((o) => o.event)
  assert.deepEqual(events, ['task-picked', 'plan', 'stop'])
  assert.equal(engine.origin.states.planning, 'planning.json')
  assert.equal(engine.origin.events['idle plan'], 'planning.json')
  assert.equal(engine.origin.events['idle task-picked'], 'workflow.json')
  const r = flowTransition.handler(engine, { event: 'plan' })
  assert.equal(r.new_state, 'planning')
  assert.equal(JSON.parse(readFileSync(join(root, '.forge/dev-state.json'), 'utf8')).workflow_state, 'planning')
})

test('fragments merge in filename order and only fragments can make a whole workflow', () => {
  const root = project()
  rmSync(join(root, '.forge', 'workflow.json'))
  fragment(root, 'b.json', { states: { idle: { transitions: [{ event: 'second', target: 'idle' }] } } })
  fragment(root, 'a.json', {
    initial_state: 'idle',
    states: { idle: { description: 'Start', transitions: [{ event: 'first', target: 'idle' }] } },
  })
  const engine = engineFor(root)
  assert.equal(engine.sources.base, null)
  assert.deepEqual(
    engine.graph.transitions('idle').map((t) => t.event),
    ['first', 'second'],
  )
  assert.equal(engine.graph.state('idle').description, 'Start')
  // Order decides listing, never ownership: b.json describing idle too is a conflict, not a loser.
  fragment(root, 'b.json', {
    states: { idle: { description: 'Also start', transitions: [{ event: 'second', target: 'idle' }] } },
  })
  assert.throws(() => engineFor(root), /b\.json: state "idle" is already defined in a\.json/)
  assert.equal(flowCheck.handler(engine, {}).state, 'idle')
})

test('no base and no fragments is the missing-workflow error', () => {
  const root = project()
  rmSync(join(root, '.forge', 'workflow.json'))
  assert.throws(
    () => engineFor(root),
    (err) =>
      err instanceof WorkflowError &&
      /No workflow at .*workflow\.json and no fragments in .*workflow\.d/.test(err.message),
  )
})

test('merge conflicts name both files', () => {
  const base = { label: 'workflow.json', data: workflow() }
  const conflict = (data) => {
    try {
      mergeWorkflows(base, [{ label: 'x.json', data }])
    } catch (err) {
      assert.ok(err instanceof WorkflowError)
      return err.issues
    }
    assert.fail('expected a merge error')
  }
  assert.deepEqual(conflict({ states: { idle: { transitions: [{ event: 'task-picked', target: 'idle' }] } } }), [
    'x.json: state "idle" event "task-picked" is already defined in workflow.json',
  ])
  assert.deepEqual(conflict({ states: { idle: { description: 'Mine now' } } }), [
    'x.json: state "idle" is already defined in workflow.json; a later piece may add transitions and triggers to it, not a description',
  ])
  assert.deepEqual(conflict({ states: {}, thresholds: { max_review_rounds: 5 } }), [
    'x.json: threshold "max_review_rounds" = 5 disagrees with workflow.json (3)',
  ])
  assert.deepEqual(conflict({ states: {}, initial_state: 'escalated' }), [
    'x.json: initial_state "escalated" disagrees with workflow.json ("idle")',
  ])
  assert.deepEqual(conflict({ states: {}, resumption_targets: { idle: 'escalated' } }), [
    'x.json: resumption target "idle" → "escalated" disagrees with workflow.json ("idle")',
  ])
  assert.deepEqual(conflict({ states: {}, global_transitions: [{ event: 'stop', target: 'idle' }] }), [
    'x.json: global event "stop" is already defined in workflow.json',
  ])
  // Agreeing values and repeated actions are fine.
  const ok = mergeWorkflows(base, [
    { label: 'x.json', data: { states: {}, thresholds: { max_review_rounds: 3 }, global_actions: ['/help', '/more'] } },
  ])
  assert.deepEqual(ok.workflow.global_actions, ['/help', '/more'])
})

test('a fragment is checked on its own shape, and the merged graph on its references', () => {
  const root = project()
  fragment(root, 'bad.json', { states: {}, config: { state_file: 'x' } })
  assert.throws(
    () => engineFor(root),
    /bad\.json is not a valid workflow fragment[\s\S]*"config" belongs to the base workflow/,
  )
  fragment(root, 'bad.json', { states: { planning: { transitions: [{ event: 'go', target: 'nowhere' }] } } })
  assert.throws(
    () => engineFor(root),
    /1 fragment\(s\) in workflow\.d\/ is not a valid workflow[\s\S]*unknown state "nowhere"/,
  )
})

test('flow_modify edits the base file only and sees the fragments', () => {
  const root = project()
  fragment(root, 'planning.json', planning())
  const engine = engineFor(root)
  const refused = (args) => flowModify.handler(engine, { ...args, confirm: true }).error
  assert.match(refused({ operation: 'add_state', state_name: 'planning' }), /defined in workflow\.d\/planning\.json/)
  assert.match(refused({ operation: 'remove_state', state_name: 'planning' }), /defined in workflow\.d\/planning\.json/)
  assert.match(
    refused({ operation: 'add_transition', state_name: 'planning', transition: { event: 'x', target: 'idle' } }),
    /planning\.json/,
  )
  assert.match(
    refused({ operation: 'add_trigger', state_name: 'planning', trigger: { condition: 'always', target: 'idle' } }),
    /planning\.json/,
  )
  assert.match(
    refused({ operation: 'remove_transition', state_name: 'idle', transition: { event: 'plan' } }),
    /Event "plan" on state "idle" is defined in workflow\.d\/planning\.json/,
  )
  // A base state a fragment points at cannot be removed.
  assert.match(refused({ operation: 'remove_state', state_name: 'idle' }), /referenced by .*planning → plan-done/)
  // A base edit that targets a fragment state is fine, and lands in the base file only.
  const applied = flowModify.handler(engine, {
    operation: 'add_transition',
    state_name: 'escalated',
    transition: { event: 'replan', target: 'planning' },
    confirm: true,
  })
  assert.equal(applied.applied, true)
  const base = JSON.parse(readFileSync(join(root, '.forge/workflow.json'), 'utf8'))
  assert.equal(base.states.planning, undefined)
  assert.ok(base.states.escalated.transitions.some((t) => t.event === 'replan'))
  assert.ok(engine.graph.transitions('escalated').some((t) => t.event === 'replan'))
  assert.ok(engine.graph.state('planning'))
  assert.equal(flowModify.handler(engine, { operation: 'preview' }).sources.fragments.length, 1)
  // A base edit that would collide with a fragment is refused before anything is written.
  const before = readFileSync(join(root, '.forge/workflow.json'), 'utf8')
  const collide = flowModify.handler(engine, {
    operation: 'add_transition',
    state_name: 'idle',
    transition: { event: 'plan', target: 'idle' },
    confirm: true,
  })
  assert.match(collide.error, /already has an event "plan"/)
  assert.equal(readFileSync(join(root, '.forge/workflow.json'), 'utf8'), before)
})

test('flow_modify needs a base file to edit', () => {
  const root = project()
  rmSync(join(root, '.forge', 'workflow.json'))
  fragment(root, 'a.json', { initial_state: 'idle', states: { idle: {} } })
  assert.throws(
    () => flowModify.handler(engineFor(root), { operation: 'add_state', state_name: 'x', confirm: true }),
    /composed from fragments only/,
  )
})
