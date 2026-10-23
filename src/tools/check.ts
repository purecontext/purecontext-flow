import type { Engine } from '../engine.js'
import type { CheckContext } from '../types.js'

export const schema = {
  name: 'flow_check',
  description:
    'What can happen next. Given the current state (or reading it from the state file when omitted), returns an auto_action if a trigger fires, otherwise the valid transitions. Call it before acting, and after every flow_transition.',
  inputSchema: {
    type: 'object',
    properties: {
      workflow_state: {
        type: 'string',
        description: 'Current state. Omit to read it from the state file (falls back to initial_state).',
      },
      project_path: {
        type: 'string',
        description:
          'Project directory whose state file to read when workflow_state is omitted: relative to the root, or absolute.',
      },
      event: {
        type: 'string',
        description: 'Optional: the event that just occurred, recorded for context only.',
      },
      context: {
        type: 'object',
        description:
          'Values trigger conditions read, by dotted path (e.g. session_counters.review_rounds). Include the previous state under previous_workflow_state to resolve a resumption.',
        additionalProperties: true,
      },
    },
  },
} as const

export interface CheckArgs {
  workflow_state?: string
  project_path?: string
  event?: string
  context?: CheckContext
}

export function handler(engine: Engine, { workflow_state, project_path, context }: CheckArgs) {
  const { graph } = engine
  let stateName = workflow_state
  let previous: string | undefined
  let fromFile: string | undefined
  if (!stateName) {
    const current = engine.current(project_path)
    if (!current.state) {
      return {
        error: `No ${engine.config.stateField} in ${current.path} and the workflow has no initial_state`,
        state_path: current.path,
      }
    }
    stateName = current.state
    fromFile = current.path
    previous = engine.previousState(current.data, context)
  } else {
    previous = engine.previousState({}, context)
  }

  const state = graph.state(stateName)
  if (!state) {
    return { error: `Unknown state: "${stateName}"`, valid_states: graph.stateNames() }
  }

  const base = {
    state: stateName,
    description: state.description ?? null,
    ...(fromFile ? { state_path: fromFile } : {}),
    global_actions: graph.globalActions(),
  }

  if (graph.hasResumption(stateName)) {
    const resumption = graph.resolveResumption(previous)
    if (resumption) {
      return {
        ...base,
        auto_action: null,
        resumption: { previous_state: previous, resume_to: resumption.target, description: resumption.description },
        options: [
          {
            event: resumption.event,
            target: resumption.target,
            action: null,
            judgment: false,
            global: false,
            description: resumption.description,
          },
        ],
      }
    }
  }

  const trigger = graph.evaluateTriggers(stateName, context ?? {})
  if (trigger) {
    engine.log({
      type: 'trigger',
      state: stateName,
      trigger: trigger.condition,
      context: context ?? null,
      target: trigger.target,
    })
    return {
      ...base,
      auto_action: {
        action: trigger.action ?? null,
        target: trigger.target,
        reason: trigger.description ?? null,
        trigger_condition: trigger.condition,
      },
      options: [],
    }
  }

  return {
    ...base,
    auto_action: null,
    options: graph.availableTransitions(stateName).map((t) => ({
      event: t.event,
      target: t.target,
      action: t.action ?? null,
      judgment: t.judgment ?? false,
      global: t.global ?? false,
      description: t.description ?? null,
    })),
  }
}
