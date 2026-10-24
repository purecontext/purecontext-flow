import { readFileSync } from 'node:fs'
import { basename } from 'node:path'
import type { Engine } from '../engine.js'
import { writeFileAtomic } from '../state.js'
import type { Transition, Trigger, Workflow } from '../types.js'
import { type LoadedWorkflow, WorkflowGraph, composeWorkflow, validateWorkflow } from '../workflow.js'

export const schema = {
  name: 'flow_modify',
  description:
    'Guided edits to the workflow file the server runs on: add or remove states and transitions, add triggers, update thresholds. Returns a preview until confirm is true. On confirm the file is rewritten as 2-space JSON and the running server loads the new graph at once. Edits the base file only: a state, event or threshold defined in a workflow.d/ fragment is refused with the fragment named.',
  inputSchema: {
    type: 'object',
    properties: {
      operation: {
        type: 'string',
        enum: [
          'add_state',
          'remove_state',
          'add_transition',
          'remove_transition',
          'add_trigger',
          'update_threshold',
          'preview',
        ],
      },
      state_name: { type: 'string' },
      state_description: { type: 'string', description: 'add_state only.' },
      transition: {
        type: 'object',
        properties: {
          event: { type: 'string' },
          target: { type: 'string' },
          action: { type: 'string' },
          judgment: { type: 'boolean' },
          description: { type: 'string' },
        },
      },
      trigger: {
        type: 'object',
        properties: {
          condition: { type: 'string' },
          target: { type: 'string' },
          action: { type: 'string' },
          description: { type: 'string' },
        },
      },
      threshold_key: { type: 'string' },
      threshold_value: { type: 'number' },
      confirm: { type: 'boolean', description: 'Apply the change. Without it, preview only.' },
    },
    required: ['operation'],
  },
} as const

export interface ModifyArgs {
  operation:
    | 'add_state'
    | 'remove_state'
    | 'add_transition'
    | 'remove_transition'
    | 'add_trigger'
    | 'update_threshold'
    | 'preview'
  state_name?: string
  state_description?: string
  transition?: Partial<Transition>
  trigger?: Partial<Trigger>
  threshold_key?: string
  threshold_value?: number
  confirm?: boolean
}

type Change = { error: string } | { change: Record<string, unknown>; apply: (w: Workflow) => void }

export function handler(engine: Engine, args: ModifyArgs) {
  const path = engine.config.workflowPath
  const readBase = (): Workflow => {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as Workflow
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT')
        throw new Error(
          `flow_modify edits ${path}, which does not exist; the graph is composed from fragments only. Create the file to edit it.`,
        )
      throw err
    }
  }
  // The merged graph as the files are now (two edits in one session must see each other).
  const read = () => composeWorkflow(readBase(), path)

  if (args.operation === 'preview') {
    const w = read().workflow
    const states: Record<string, unknown> = {}
    for (const [name, s] of Object.entries(w.states)) {
      states[name] = {
        description: s.description ?? null,
        transitions: (s.transitions ?? []).map((t) => `${t.event} → ${t.target}`),
        triggers: (s.triggers ?? []).map((t) => `${t.condition} → ${t.target}`),
      }
    }
    return {
      path,
      sources: engine.sources,
      name: w.name ?? null,
      version: w.version ?? null,
      initial_state: w.initial_state ?? null,
      total_states: Object.keys(w.states).length,
      thresholds: w.thresholds ?? {},
      global_actions: w.global_actions ?? [],
      states,
    }
  }

  const result = compute(args, read, basename(path))
  if ('error' in result) return result
  if (!args.confirm) {
    return {
      preview: true,
      operation: args.operation,
      change: result.change,
      message: 'Set confirm: true to apply.',
    }
  }
  const base = readBase()
  result.apply(base)
  let loaded: ReturnType<typeof composeWorkflow>
  try {
    loaded = composeWorkflow(base, path)
  } catch (err) {
    return {
      error: 'The change would leave the workflow invalid; nothing was written',
      issues: [(err as Error).message],
    }
  }
  const issues = validateWorkflow(loaded.workflow)
  if (issues.length) return { error: 'The change would leave the workflow invalid; nothing was written', issues }
  writeFileAtomic(path, `${JSON.stringify(base, null, 2)}\n`)
  engine.reload(loaded)
  return {
    applied: true,
    operation: args.operation,
    change: result.change,
    path,
    message: `Written to ${path} and loaded.`,
  }
}

// Checks run against the files as they are now, not the graph the server loaded
// at startup: two edits in one session must see each other, and a fragment that
// appeared since startup owns its states from this call on. Only the base file
// (`baseLabel`) is editable here.
function compute(args: ModifyArgs, read: () => LoadedWorkflow, baseLabel: string): Change {
  const { workflow: current, origin } = read()
  const graph = new WorkflowGraph(current)
  const { operation, state_name, state_description, transition, trigger, threshold_key, threshold_value } = args
  const owned = (what: string, file: string | undefined) => {
    if (!file || file === baseLabel) return null
    const plugin = origin.names[file]
    return {
      error: plugin
        ? `${what} is defined by ${plugin} (workflow.d/${file}); change it in the ${plugin} plugin`
        : `${what} is defined in workflow.d/${file}; edit that fragment instead`,
    }
  }
  switch (operation) {
    case 'add_state': {
      if (!state_name) return { error: 'state_name is required for add_state' }
      if (graph.state(state_name))
        return (
          owned(`State "${state_name}"`, origin.states[state_name]) ?? { error: `State "${state_name}" already exists` }
        )
      return {
        change: { state_name, description: state_description ?? '', transitions: [], triggers: [] },
        apply: (w) => {
          w.states[state_name] = { description: state_description ?? '', transitions: [] }
        },
      }
    }
    case 'remove_state': {
      if (!state_name) return { error: 'state_name is required for remove_state' }
      if (!graph.state(state_name)) return { error: `State "${state_name}" does not exist` }
      const ownedState = owned(`State "${state_name}"`, origin.states[state_name])
      if (ownedState) return ownedState
      const refs: string[] = []
      for (const name of graph.stateNames()) {
        if (name === state_name) continue
        for (const t of graph.transitions(name)) if (t.target === state_name) refs.push(`${name} → ${t.event}`)
        for (const t of graph.triggers(name))
          if (t.target === state_name) refs.push(`${name} → trigger: ${t.condition}`)
      }
      for (const t of graph.globalTransitions()) if (t.target === state_name) refs.push(`global → ${t.event}`)
      if (refs.length)
        return { error: `Cannot remove "${state_name}": referenced by ${refs.join(', ')}. Remove those first.` }
      return {
        change: { removed_state: state_name },
        apply: (w) => {
          delete w.states[state_name]
          if (w.resumption_targets) delete w.resumption_targets[state_name]
          if (w.initial_state === state_name) w.initial_state = undefined
          for (const g of w.global_transitions ?? []) if (g.except) g.except = g.except.filter((s) => s !== state_name)
        },
      }
    }
    case 'add_transition': {
      if (!state_name) return { error: 'state_name is required for add_transition' }
      if (!transition?.event) return { error: 'transition.event is required' }
      if (!graph.state(state_name)) return { error: `State "${state_name}" does not exist` }
      const ownedSource = owned(`State "${state_name}"`, origin.states[state_name])
      if (ownedSource) return ownedSource
      if (transition.target && !graph.state(transition.target))
        return { error: `Target state "${transition.target}" does not exist` }
      if (graph.transitions(state_name).some((t) => t.event === transition.event)) {
        return { error: `State "${state_name}" already has an event "${transition.event}"` }
      }
      const event = transition.event
      return {
        change: { state: state_name, added_transition: transition },
        apply: (w) => {
          const s = w.states[state_name]
          s.transitions ??= []
          s.transitions.push({
            event,
            target: transition.target ?? null,
            action: transition.action ?? null,
            ...(transition.judgment ? { judgment: true } : {}),
            ...(transition.description ? { description: transition.description } : {}),
          })
        },
      }
    }
    case 'remove_transition': {
      if (!state_name) return { error: 'state_name is required for remove_transition' }
      if (!transition?.event) return { error: 'transition.event is required' }
      if (!graph.state(state_name)) return { error: `State "${state_name}" does not exist` }
      const existing = graph.transitions(state_name).find((t) => t.event === transition.event)
      if (!existing) return { error: `No transition with event "${transition.event}" on state "${state_name}"` }
      const ownedEvent = owned(
        `Event "${transition.event}" on state "${state_name}"`,
        origin.events[`${state_name} ${transition.event}`],
      )
      if (ownedEvent) return ownedEvent
      return {
        change: { state: state_name, removed_transition: existing },
        apply: (w) => {
          const s = w.states[state_name]
          s.transitions = (s.transitions ?? []).filter((t) => t.event !== transition.event)
        },
      }
    }
    case 'add_trigger': {
      if (!state_name) return { error: 'state_name is required for add_trigger' }
      if (!trigger?.condition) return { error: 'trigger.condition is required' }
      if (!graph.state(state_name)) return { error: `State "${state_name}" does not exist` }
      const ownedTriggerState = owned(`State "${state_name}"`, origin.states[state_name])
      if (ownedTriggerState) return ownedTriggerState
      const condition = trigger.condition
      return {
        change: { state: state_name, added_trigger: trigger },
        apply: (w) => {
          const s = w.states[state_name]
          s.triggers ??= []
          s.triggers.push({
            condition,
            target: trigger.target ?? null,
            action: trigger.action ?? null,
            ...(trigger.description ? { description: trigger.description } : {}),
          })
        },
      }
    }
    case 'update_threshold': {
      if (!threshold_key) return { error: 'threshold_key is required for update_threshold' }
      if (threshold_value === undefined) return { error: 'threshold_value is required for update_threshold' }
      const current = graph.thresholds()[threshold_key]
      const ownedThreshold = owned(`Threshold "${threshold_key}"`, origin.thresholds[threshold_key])
      if (ownedThreshold) return ownedThreshold
      return {
        change: { threshold: threshold_key, old_value: current ?? null, new_value: threshold_value },
        apply: (w) => {
          w.thresholds ??= {}
          w.thresholds[threshold_key] = threshold_value
        },
      }
    }
    default:
      return { error: `Unknown operation: "${operation}"` }
  }
}
