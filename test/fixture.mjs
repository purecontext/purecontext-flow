import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** A build-style lifecycle plus a resumption state, enough to exercise every engine path. */
export const workflow = () => ({
  name: 'test-lifecycle',
  initial_state: 'idle',
  states: {
    idle: {
      description: 'Nothing active',
      transitions: [{ event: 'task-picked', target: 'implementing', action: '/next' }],
    },
    implementing: {
      description: 'Working',
      transitions: [
        { event: 'done', target: 'in-review', action: null },
        { event: 'abandon', target: 'idle', action: null },
      ],
    },
    'in-review': {
      description: 'Under review',
      triggers: [
        {
          condition: 'session_counters.review_rounds >= thresholds.max_review_rounds',
          target: 'escalated',
          action: null,
          description: 'Too many rounds',
        },
      ],
      transitions: [
        { event: 'approved', target: 'idle', action: '/merged' },
        {
          event: 'changes-requested',
          target: 'implementing',
          action: '/iterate',
          judgment: true,
          description: 'Reviewer wants changes',
        },
      ],
    },
    escalated: { description: 'Needs a human', transitions: [{ event: 'resolved', target: 'idle', action: null }] },
    cleared: { description: 'Fresh session', transitions: [{ event: 'resume', target: null, action: null }] },
  },
  global_transitions: [{ event: 'stop', target: 'cleared', action: '/break', except: ['cleared'] }],
  global_actions: ['/help'],
  thresholds: { max_review_rounds: 3 },
  resumption_targets: { idle: 'idle', implementing: 'implementing', 'in-review': 'in-review', escalated: 'escalated' },
})

/** A temp project with .forge/workflow.json and, optionally, a state file. */
export function project({ workflow: w = workflow(), state, stateFile = '.forge/dev-state.json' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'flow-'))
  mkdirSync(join(root, '.forge'), { recursive: true })
  writeFileSync(join(root, '.forge', 'workflow.json'), `${JSON.stringify(w, null, 2)}\n`)
  if (state) {
    mkdirSync(join(root, stateFile, '..'), { recursive: true })
    writeFileSync(join(root, stateFile), `${JSON.stringify(state, null, 2)}\n`)
  }
  return root
}
