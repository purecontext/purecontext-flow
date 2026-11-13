import type { Engine } from '../engine.js'
import type { StateData } from '../types.js'

export const schema = {
  name: 'flow_update',
  description:
    'Write fields to the state file without changing state: a counter, a task id, a PR number. Merged shallowly in one write and logged. The state field and previous-state field cannot be set here; only flow_transition changes state.',
  inputSchema: {
    type: 'object',
    properties: {
      state_updates: {
        type: 'object',
        description:
          'Fields merged into the state file. Top-level keys replace whole values: to change one counter in session_counters, pass the whole object.',
        additionalProperties: true,
      },
      project_path: {
        type: 'string',
        description:
          'Project directory whose state file to update: relative to the root, or absolute. Omit for the root itself.',
      },
      context: { type: 'object', description: 'Recorded with the log entry.', additionalProperties: true },
    },
    required: ['state_updates'],
  },
} as const

export interface UpdateArgs {
  state_updates?: StateData
  project_path?: string
  context?: Record<string, unknown>
}

export function handler(engine: Engine, { state_updates, project_path, context }: UpdateArgs) {
  const { config } = engine
  if (!state_updates || typeof state_updates !== 'object' || Array.isArray(state_updates)) {
    return { error: 'state_updates must be an object of fields to write' }
  }
  let current: ReturnType<Engine['current']>
  try {
    current = engine.current(project_path)
  } catch (err) {
    return { error: `Failed to read the state file: ${(err as Error).message}` }
  }
  const { path, data } = current
  const reserved = new Set([config.stateField, config.previousStateField])
  const rejected: string[] = []
  const applied: string[] = []
  for (const [key, value] of Object.entries(state_updates)) {
    if (reserved.has(key)) rejected.push(key)
    else {
      data[key] = value
      applied.push(key)
    }
  }
  if (!applied.length) {
    return {
      error: rejected.length
        ? `Only reserved fields were given (${rejected.join(', ')}); change state with flow_transition`
        : 'state_updates is empty: nothing to write',
      state_path: path,
    }
  }

  try {
    engine.writeState(path, data)
  } catch (err) {
    return { error: `Failed to write the state file: ${(err as Error).message}`, state_path: path }
  }

  // The state as the file names it; an initial_state fallback is not written by an update.
  const state = current.initial ? null : current.state
  engine.log({ type: 'update', state, fields: applied, context: context ?? null, state_path: path })

  return {
    success: true,
    state,
    updated_fields: applied,
    state_path: path,
    ...(rejected.length ? { ignored_state_updates: rejected } : {}),
    updated_state: data,
  }
}
