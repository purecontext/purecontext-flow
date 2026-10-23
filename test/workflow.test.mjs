import assert from 'node:assert/strict'
import { test } from 'node:test'
import { WorkflowGraph, evaluateCondition, parseCondition, validateWorkflow } from '../dist/index.js'
import { workflow } from './fixture.mjs'

test('a well-formed workflow validates clean', () => {
  assert.deepEqual(validateWorkflow(workflow()), [])
})

test('validation names every broken reference', () => {
  const w = workflow()
  w.states.idle.transitions[0].target = 'nowhere'
  w.states['in-review'].triggers[0].condition = 'review_rounds is big'
  w.states['in-review'].triggers.push({ condition: 'always', target: 'gone' })
  w.global_transitions[0].except.push('ghost')
  w.initial_state = 'missing'
  w.resumption_targets.idle = 'elsewhere'
  w.thresholds.max_review_rounds = 'three'
  w.states.implementing.transitions.push({ event: 'done', target: 'idle' })
  const issues = validateWorkflow(w)
  const expect = (fragment) =>
    assert.ok(
      issues.some((i) => i.includes(fragment)),
      `expected an issue mentioning ${fragment}; got\n${issues.join('\n')}`,
    )
  expect('targets unknown state "nowhere"')
  expect('"review_rounds is big" is not')
  expect('targets unknown state "gone"')
  expect('excepts unknown state "ghost"')
  expect('"initial_state" "missing"')
  expect('resumes to unknown state "elsewhere"')
  expect('threshold "max_review_rounds" must be a number')
  expect('event "done" is defined twice')
  assert.equal(issues.length, 8)
})

test('a null target needs resumption_targets', () => {
  const w = workflow()
  w.resumption_targets = undefined
  assert.ok(validateWorkflow(w).some((i) => i.includes('null target but the workflow has no "resumption_targets"')))
})

test('non-object input is rejected before anything else', () => {
  assert.deepEqual(validateWorkflow(null), ['workflow must be a JSON object'])
  assert.deepEqual(validateWorkflow({ states: [] }), ['"states" must be an object of state name → state'])
})

test('conditions: always, thresholds, literals, operators, missing sides', () => {
  assert.deepEqual(parseCondition('always'), { kind: 'always' })
  assert.deepEqual(parseCondition('a.b >= thresholds.x'), {
    kind: 'compare',
    left: 'a.b',
    op: '>=',
    right: { path: 'thresholds.x' },
  })
  assert.deepEqual(parseCondition('a.b < 2.5'), { kind: 'compare', left: 'a.b', op: '<', right: { value: 2.5 } })
  assert.equal(parseCondition('a.b ~ 2'), null)
  assert.equal(parseCondition('a.b >= thresholds.x && c'), null)
  const scope = { session_counters: { rounds: 3 }, thresholds: { max: 3 } }
  assert.equal(evaluateCondition('session_counters.rounds >= thresholds.max', scope), true)
  assert.equal(evaluateCondition('session_counters.rounds > thresholds.max', scope), false)
  assert.equal(evaluateCondition('session_counters.rounds == 3', scope), true)
  assert.equal(evaluateCondition('session_counters.rounds != 3', scope), false)
  assert.equal(evaluateCondition('session_counters.rounds <= 2', scope), false)
  assert.equal(
    evaluateCondition('session_counters.missing < 1', scope),
    true,
    'a missing counter in an existing object reads as 0',
  )
  assert.equal(
    evaluateCondition('sesion_counters.rounds < 1', scope),
    null,
    'a typo in the parent is unresolvable, not 0',
  )
  assert.equal(evaluateCondition('top_level_missing < 1', scope), true, 'a bare missing key at the top reads as 0')
  assert.equal(
    evaluateCondition('session_counters.rounds >= thresholds.missing', scope),
    null,
    'a missing threshold is unresolvable',
  )
  assert.equal(evaluateCondition('nonsense', scope), null)
})

test('graph: globals apply outside their except list and lose to a state-specific event', () => {
  const w = workflow()
  w.states.escalated.transitions.push({ event: 'stop', target: 'idle', action: null })
  const g = new WorkflowGraph(w)
  assert.deepEqual(
    g.availableTransitions('idle').map((t) => [t.event, t.global ?? false]),
    [
      ['task-picked', false],
      ['stop', true],
    ],
  )
  assert.equal(g.findTransition('escalated', 'stop').target, 'idle', 'own transition wins')
  assert.equal(g.findTransition('cleared', 'stop'), null, 'excepted state has no global')
  assert.equal(g.availableTransitions('idle')[1].except, undefined, 'except is not leaked into options')
})

test('graph: triggers fire on the first true condition and never on an unresolvable one', () => {
  const g = new WorkflowGraph(workflow())
  assert.equal(g.evaluateTriggers('in-review', { session_counters: { review_rounds: 2 } }), null)
  assert.equal(g.evaluateTriggers('in-review', { session_counters: { review_rounds: 3 } }).target, 'escalated')
  assert.equal(g.evaluateTriggers('in-review', {}), null, 'no counters, no trigger')
  const w = workflow()
  w.thresholds = {}
  w.states['in-review'].triggers[0].condition = 'session_counters.review_rounds >= thresholds.undefined_key'
  assert.equal(new WorkflowGraph(w).evaluateTriggers('in-review', { session_counters: { review_rounds: 99 } }), null)
})

test('graph: resumption resolves from the previous state', () => {
  const g = new WorkflowGraph(workflow())
  assert.equal(g.hasResumption('cleared'), true)
  assert.equal(g.hasResumption('idle'), false)
  assert.equal(g.resolveResumption('implementing').target, 'implementing')
  assert.equal(g.resolveResumption('cleared'), null, 'a state without a resumption target resolves to nothing')
  assert.equal(g.resolveResumption(undefined), null)
})
