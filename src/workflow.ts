import { readFileSync } from 'node:fs'
import { evaluateCondition, parseCondition } from './conditions.js'
import type { CheckContext, GlobalTransition, State, Transition, Trigger, Workflow } from './types.js'

export class WorkflowError extends Error {
  issues: string[]
  constructor(message: string, issues: string[] = []) {
    super(issues.length ? `${message}\n  - ${issues.join('\n  - ')}` : message)
    this.name = 'WorkflowError'
    this.issues = issues
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Structural and referential checks. Returns an empty list for a valid workflow. */
export function validateWorkflow(input: unknown): string[] {
  const issues: string[] = []
  if (!isObject(input)) return ['workflow must be a JSON object']
  const w = input as Partial<Workflow>
  if (!isObject(w.states)) return ['"states" must be an object of state name → state']
  const names = Object.keys(w.states)
  if (names.length === 0) issues.push('"states" is empty')
  const known = (name: unknown) => typeof name === 'string' && name in (w.states as object)

  const checkTransition = (t: unknown, where: string) => {
    if (!isObject(t)) return issues.push(`${where}: transition must be an object`)
    if (typeof t.event !== 'string' || !t.event) issues.push(`${where}: transition needs a string "event"`)
    if (t.target !== null && !known(t.target))
      issues.push(`${where}: event "${t.event}" targets unknown state "${t.target}"`)
    if (t.target === null && !isObject(w.resumption_targets)) {
      issues.push(`${where}: event "${t.event}" has a null target but the workflow has no "resumption_targets"`)
    }
  }
  const checkTrigger = (t: unknown, where: string) => {
    if (!isObject(t)) return issues.push(`${where}: trigger must be an object`)
    const parsed = typeof t.condition === 'string' ? parseCondition(t.condition) : null
    if (!parsed) {
      issues.push(`${where}: trigger condition "${t.condition}" is not "always" or "<path> <op> <path|number>"`)
    } else if (parsed.kind === 'compare' && 'path' in parsed.right && parsed.right.path.startsWith('thresholds.')) {
      const key = parsed.right.path.slice('thresholds.'.length)
      if (!isObject(w.thresholds) || !(key in w.thresholds)) {
        issues.push(`${where}: trigger "${t.condition}" reads thresholds.${key}, which the workflow does not define`)
      }
    }
    if (!known(t.target)) issues.push(`${where}: trigger "${t.condition}" targets unknown state "${t.target}"`)
  }

  for (const [name, state] of Object.entries(w.states)) {
    if (!isObject(state)) {
      issues.push(`state "${name}" must be an object`)
      continue
    }
    const s = state as State
    if (s.transitions !== undefined && !Array.isArray(s.transitions))
      issues.push(`state "${name}": "transitions" must be an array`)
    if (s.triggers !== undefined && !Array.isArray(s.triggers))
      issues.push(`state "${name}": "triggers" must be an array`)
    for (const t of Array.isArray(s.transitions) ? s.transitions : []) checkTransition(t, `state "${name}"`)
    for (const t of Array.isArray(s.triggers) ? s.triggers : []) checkTrigger(t, `state "${name}"`)
    const events = (Array.isArray(s.transitions) ? s.transitions : []).map((t) => t?.event)
    const dup = events.find((e, i) => events.indexOf(e) !== i)
    if (dup) issues.push(`state "${name}": event "${dup}" is defined twice`)
  }

  if (w.global_transitions !== undefined) {
    if (!Array.isArray(w.global_transitions)) issues.push('"global_transitions" must be an array')
    else {
      for (const t of w.global_transitions) {
        checkTransition(t, 'global_transitions')
        for (const ex of isObject(t) && Array.isArray(t.except) ? t.except : []) {
          if (!known(ex)) issues.push(`global_transitions: event "${t.event}" excepts unknown state "${ex}"`)
        }
      }
    }
  }
  if (w.initial_state !== undefined && !known(w.initial_state))
    issues.push(`"initial_state" "${w.initial_state}" is not a state`)
  if (w.thresholds !== undefined) {
    if (!isObject(w.thresholds)) issues.push('"thresholds" must be an object')
    else
      for (const [k, v] of Object.entries(w.thresholds))
        if (typeof v !== 'number') issues.push(`threshold "${k}" must be a number`)
  }
  if (w.resumption_targets !== undefined) {
    if (!isObject(w.resumption_targets)) issues.push('"resumption_targets" must be an object')
    else {
      for (const [from, to] of Object.entries(w.resumption_targets)) {
        if (!known(from)) issues.push(`resumption_targets: "${from}" is not a state`)
        if (!known(to)) issues.push(`resumption_targets: "${from}" resumes to unknown state "${to}"`)
      }
    }
  }
  if (w.global_actions !== undefined && !Array.isArray(w.global_actions))
    issues.push('"global_actions" must be an array')
  if (w.config !== undefined && !isObject(w.config)) issues.push('"config" must be an object')
  return issues
}

export function parseWorkflow(raw: string, source = 'workflow'): Workflow {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new WorkflowError(`${source} is not valid JSON: ${(err as Error).message}`)
  }
  const issues = validateWorkflow(data)
  if (issues.length) throw new WorkflowError(`${source} is not a valid workflow`, issues)
  return data as Workflow
}

export function loadWorkflow(path: string): Workflow {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new WorkflowError(`No workflow at ${path}. Create one (see the workflow schema) and restart the server.`)
    }
    throw err
  }
  return parseWorkflow(raw, path)
}

export interface AvailableTransition extends Transition {
  global?: boolean
}

export interface Resumption {
  event: 'resume'
  target: string
  action: null
  description: string
}

/** Read-only queries over a validated workflow. */
export class WorkflowGraph {
  constructor(readonly workflow: Workflow) {}

  state(name: string): State | null {
    return this.workflow.states[name] ?? null
  }

  stateNames(): string[] {
    return Object.keys(this.workflow.states)
  }

  transitions(name: string): Transition[] {
    return this.state(name)?.transitions ?? []
  }

  triggers(name: string): Trigger[] {
    return this.state(name)?.triggers ?? []
  }

  globalTransitions(name?: string): GlobalTransition[] {
    const all = this.workflow.global_transitions ?? []
    return name ? all.filter((t) => !(t.except ?? []).includes(name)) : all
  }

  /** State-specific transitions plus applicable globals; a state-specific event wins over a global one. */
  availableTransitions(name: string): AvailableTransition[] {
    const own = this.transitions(name)
    const ownEvents = new Set(own.map((t) => t.event))
    const globals = this.globalTransitions(name)
      .filter((t) => !ownEvents.has(t.event))
      .map(({ except: _except, ...t }) => ({ ...t, global: true }))
    return [...own, ...globals]
  }

  thresholds(): Record<string, number> {
    return this.workflow.thresholds ?? {}
  }

  globalActions(): string[] {
    return this.workflow.global_actions ?? []
  }

  initialState(): string | null {
    return this.workflow.initial_state ?? null
  }

  findTransition(name: string, event: string): AvailableTransition | null {
    return this.availableTransitions(name).find((t) => t.event === event) ?? null
  }

  /** Whether any transition out of this state resolves its target from the previous state. */
  hasResumption(name: string): boolean {
    return this.availableTransitions(name).some((t) => t.target === null)
  }

  resumptionTarget(previous: string): string | null {
    return this.workflow.resumption_targets?.[previous] ?? null
  }

  resolveResumption(previous: string | undefined | null): Resumption | null {
    if (!previous) return null
    const target = this.resumptionTarget(previous)
    if (!target) return null
    return { event: 'resume', target, action: null, description: `Resume from ${previous}, entering ${target}` }
  }

  /** The first trigger whose condition holds, or null. */
  evaluateTriggers(name: string, context: CheckContext = {}): Trigger | null {
    const scope = { ...context, thresholds: { ...this.thresholds(), ...(context.thresholds as object | undefined) } }
    for (const trigger of this.triggers(name)) {
      if (evaluateCondition(trigger.condition, scope) === true) return trigger
    }
    return null
  }
}
