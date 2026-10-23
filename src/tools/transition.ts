import type { Engine } from '../engine.js'
import type { StateData } from '../types.js'

export const schema = {
  name: 'flow_transition',
  description:
    'The one way to change state. Validates the event against the current state, writes the new state to the state file, and logs the transition. Never write the state field directly.',
  inputSchema: {
    type: 'object',
    properties: {
      event: { type: 'string', description: 'The event to apply (from flow_check options).' },
      project_path: {
        type: 'string',
        description:
          'Project directory whose state file to update: relative to the root, or absolute. Omit for the root itself.',
      },
      state_updates: {
        type: 'object',
        description:
          'Fields merged into the state file in the same write as the state change. The state field and previous-state field cannot be set here.',
        additionalProperties: true,
      },
      context: { type: 'object', description: 'Recorded with the log entry.', additionalProperties: true },
      judgment: {
        type: 'object',
        description: 'When the agent evaluated a condition to choose this event, what it decided and why.',
        properties: {
          condition: { type: 'string' },
          result: { type: 'boolean' },
          reasoning: { type: 'string' },
        },
      },
    },
    required: ['event'],
  },
} as const

export interface TransitionArgs {
  event: string
  project_path?: string
  state_updates?: StateData
  context?: Record<string, unknown>
  judgment?: { condition?: string; result?: boolean; reasoning?: string }
}

export function handler(engine: Engine, { event, project_path, state_updates, context, judgment }: TransitionArgs) {
  const { graph, config } = engine
  let current: ReturnType<Engine['current']>
  try {
    current = engine.current(project_path)
  } catch (err) {
    return {
      error: `Failed to read the state file: ${(err as Error).message}`,
      state_path: engine.stateFile(project_path),
    }
  }
  const { path, data } = current
  if (!current.state) {
    return {
      error: current.exists
        ? `${path} has no ${config.stateField} field and the workflow has no initial_state`
        : `No state file at ${path} and the workflow has no initial_state`,
      state_path: path,
    }
  }
  const from = current.state
  if (!graph.state(from)) {
    return { error: `Unknown state in ${path}: "${from}"`, valid_states: graph.stateNames(), state_path: path }
  }

  const transition = graph.findTransition(from, event)
  if (!transition) {
    return {
      error: `Invalid transition: event "${event}" is not valid from state "${from}"`,
      valid_events: graph.availableTransitions(from).map((t) => t.event),
      state_path: path,
    }
  }

  let target = transition.target
  let description = transition.description ?? null
  if (target === null) {
    const previous = engine.previousState(data)
    const resumption = graph.resolveResumption(previous)
    if (!resumption) {
      return {
        error: `Event "${event}" from "${from}" resolves its target from the previous state, but "${previous}" has no resumption target`,
        state_path: path,
      }
    }
    target = resumption.target
    description = resumption.description
  }

  const reserved = new Set([config.stateField, config.previousStateField])
  const rejected: string[] = []
  for (const [key, value] of Object.entries(state_updates ?? {})) {
    if (reserved.has(key)) rejected.push(key)
    else data[key] = value
  }
  data[config.previousStateField] = from
  data[config.stateField] = target

  try {
    engine.writeState(path, data)
  } catch (err) {
    return { error: `Failed to write the state file: ${(err as Error).message}`, state_path: path }
  }

  engine.log({
    type: 'transition',
    from_state: from,
    to_state: target,
    event,
    action: transition.action ?? null,
    context: context ?? null,
    state_path: path,
  })
  if (judgment) {
    engine.log({
      type: 'judgment',
      state_path: path,
      state: from,
      condition: judgment.condition ?? null,
      result: judgment.result ?? null,
      reasoning: judgment.reasoning ?? null,
      chosen_transition: target,
    })
  }

  return {
    success: true,
    from_state: from,
    new_state: target,
    event,
    action: transition.action ?? null,
    description,
    state_path: path,
    ...(current.initial ? { initialized_from: 'initial_state' } : {}),
    ...(rejected.length ? { ignored_state_updates: rejected } : {}),
    updated_state: data,
  }
}
