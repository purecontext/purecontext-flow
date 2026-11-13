import { lookup, parseCondition } from '../conditions.js'
import type { Engine } from '../engine.js'
import type { CheckContext } from '../types.js'

export const schema = {
  name: 'flow_check',
  description:
    "What can happen next. Given the current state (or reading it from the state file when omitted), returns the valid transitions as options, and an auto_action when a trigger fires (its via lists the events that reach the trigger's target). Triggers read the state file's fields, with context overriding them. Call it before acting, and after every flow_transition.",
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
          "Project directory whose state file to read: for the state when workflow_state is omitted, and for trigger fields either way. Relative to the root, or absolute; omit for the root's own state file.",
      },
      event: {
        type: 'string',
        description: 'Optional: the event that just occurred, recorded for context only.',
      },
      context: {
        type: 'object',
        description:
          "Values trigger conditions read, by dotted path (e.g. session_counters.review_rounds), laid over the state file's fields: a top-level key here replaces the file's whole value. Include the previous state under previous_workflow_state to resolve a resumption.",
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
  // The state file's fields are what triggers read, so a counter a skill wrote is seen without the caller passing it.
  let fileData: Record<string, unknown> = {}
  let scopePath: string | undefined
  let stateFileError: string | undefined
  if (!stateName) {
    let current: ReturnType<Engine['current']>
    try {
      current = engine.current(project_path)
    } catch (err) {
      return { error: `Failed to read the state file: ${(err as Error).message}` }
    }
    if (!current.state) {
      return {
        error: `No ${engine.config.stateField} in ${current.path} and the workflow has no initial_state`,
        state_path: current.path,
      }
    }
    stateName = current.state
    fromFile = current.path
    previous = engine.previousState(current.data, context)
    if (current.exists) {
      fileData = current.data
      scopePath = current.path
    }
  } else {
    previous = engine.previousState({}, context)
    try {
      const current = engine.current(project_path)
      if (current.exists) {
        fileData = current.data
        scopePath = current.path
      }
    } catch (err) {
      stateFileError = (err as Error).message
    }
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
    ...(stateFileError
      ? { state_file_error: `Triggers were evaluated without the state file: ${stateFileError}` }
      : {}),
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

  // thresholds.* is the workflow's: evaluateTriggers replaces a thresholds key from the file or the context.
  const scope: CheckContext = { ...fileData, ...(context ?? {}) }
  const trigger = graph.evaluateTriggers(stateName, scope)
  const options = graph.availableTransitions(stateName).map((t) => ({
    event: t.event,
    target: t.target,
    action: t.action ?? null,
    judgment: t.judgment ?? false,
    global: t.global ?? false,
    description: t.description ?? null,
  }))
  if (trigger) {
    engine.log({
      type: 'trigger',
      state: stateName,
      trigger: trigger.condition,
      values: conditionValues(trigger.condition, scope, graph.thresholds()),
      context: context ?? null,
      target: trigger.target,
      state_path: scopePath ?? fromFile ?? null,
    })
    return {
      ...base,
      auto_action: {
        action: trigger.action ?? null,
        target: trigger.target,
        reason: trigger.description ?? null,
        trigger_condition: trigger.condition,
        // The events that reach the trigger's target: a trigger names a state, flow_transition takes an event.
        via: options.filter((o) => o.target === trigger.target).map((o) => o.event),
      },
      // Every valid transition stays listed, so an event the trigger did not anticipate (a merge) is still visible.
      options,
    }
  }

  return { ...base, auto_action: null, options }
}

/** The values a fired condition's paths resolved to, so the log says why without the state file as it was. */
function conditionValues(
  condition: string,
  scope: CheckContext,
  workflowThresholds: Record<string, number>,
): Record<string, unknown> | null {
  const parsed = parseCondition(condition)
  if (!parsed || parsed.kind !== 'compare') return null
  const full = { ...scope, thresholds: workflowThresholds }
  // The condition fired, so a missing left leaf had an existing parent: the evaluator read it as 0.
  const values: Record<string, unknown> = { [parsed.left]: lookup(full, parsed.left) ?? 0 }
  if ('path' in parsed.right) values[parsed.right.path] = lookup(full, parsed.right.path) ?? null
  return values
}
