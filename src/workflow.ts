import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
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

/** The merged workflow for a workflow path: the base file plus every fragment beside it. */
export function loadWorkflow(path: string): Workflow {
  return loadWorkflowSources(path).workflow
}

// --- fragments -----------------------------------------------------------
//
// A workflow can be composed from pieces: the base file (.forge/workflow.json)
// plus every *.json in workflow.d/ beside it, merged in filename order. Each
// fragment is a partial workflow: states it adds, transitions and triggers it
// adds to states another piece defines, global transitions, thresholds and
// resumption targets. Two pieces never define the same event on the same state,
// the same threshold with different values, or different initial states. Only
// the base carries `config`. The merged result is validated like a single file.

/** A partial workflow merged into the base at load time. Everything but `config`. */
export type WorkflowFragment = Omit<Workflow, 'config'>

/** The files a loaded workflow came from. `base` is null when only fragments exist. */
export interface WorkflowSources {
  base: string | null
  fragments: string[]
}

/** Which file defines each state, each `state event` pair and each threshold. */
export interface WorkflowOrigin {
  states: Record<string, string>
  events: Record<string, string>
  thresholds: Record<string, string>
}

export interface LoadedWorkflow {
  workflow: Workflow
  sources: WorkflowSources
  origin: WorkflowOrigin
}

/** Where a workflow's fragments live: `workflow.d/` beside the workflow file. */
export function fragmentsDir(workflowPath: string): string {
  return join(dirname(workflowPath), 'workflow.d')
}

/** The fragment files for a workflow path, in the order they merge. */
export function fragmentPaths(workflowPath: string): string[] {
  let names: string[]
  try {
    names = readdirSync(fragmentsDir(workflowPath))
  } catch {
    return []
  }
  return names
    .filter((n) => n.endsWith('.json'))
    .sort()
    .map((n) => join(fragmentsDir(workflowPath), n))
}

/** Read the base file (if any) and its fragments, merge, validate. */
export function loadWorkflowSources(path: string): LoadedWorkflow {
  let base: Workflow | null = null
  try {
    base = parseWorkflow(readFileSync(path, 'utf8'), path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
  const loaded = composeWorkflow(base, path)
  if (!base && loaded.sources.fragments.length === 0) {
    throw new WorkflowError(
      `No workflow at ${path} and no fragments in ${fragmentsDir(path)}. Create one (see the workflow schema); the server loads it on the next call.`,
    )
  }
  return loaded
}

/**
 * Merge a base workflow (already parsed, or null) with the fragments on disk
 * beside `workflowPath`. flow_modify uses this to validate an edited base
 * against the fragments before writing it.
 */
export function composeWorkflow(base: Workflow | null, workflowPath: string): LoadedWorkflow {
  const paths = fragmentPaths(workflowPath)
  const fragments = paths.map((p) => ({ label: basename(p), data: parseFragment(readFileSync(p, 'utf8'), p) }))
  const { workflow, origin } = mergeWorkflows(base ? { label: basename(workflowPath), data: base } : null, fragments)
  if (paths.length) {
    const issues = validateWorkflow(workflow)
    if (issues.length) {
      throw new WorkflowError(
        `${workflowPath} with ${paths.length} fragment(s) in workflow.d/ is not a valid workflow`,
        issues,
      )
    }
  }
  return { workflow, sources: { base: base ? workflowPath : null, fragments: paths }, origin }
}

/** Structural checks on one fragment. Referential checks run on the merged workflow. */
export function validateFragment(input: unknown): string[] {
  const issues: string[] = []
  if (!isObject(input)) return ['fragment must be a JSON object']
  const f = input as Partial<WorkflowFragment> & { config?: unknown }
  if (f.config !== undefined) issues.push('"config" belongs to the base workflow, not a fragment')
  if (f.states !== undefined && !isObject(f.states)) issues.push('"states" must be an object of state name → state')
  for (const [name, state] of Object.entries(isObject(f.states) ? f.states : {})) {
    if (!isObject(state)) {
      issues.push(`state "${name}" must be an object`)
      continue
    }
    if (state.transitions !== undefined && !Array.isArray(state.transitions))
      issues.push(`state "${name}": "transitions" must be an array`)
    if (state.triggers !== undefined && !Array.isArray(state.triggers))
      issues.push(`state "${name}": "triggers" must be an array`)
    for (const t of Array.isArray(state.transitions) ? state.transitions : [])
      if (!isObject(t) || typeof t.event !== 'string' || !t.event)
        issues.push(`state "${name}": every transition needs a string "event"`)
  }
  if (f.global_transitions !== undefined && !Array.isArray(f.global_transitions))
    issues.push('"global_transitions" must be an array')
  if (f.global_actions !== undefined && !Array.isArray(f.global_actions))
    issues.push('"global_actions" must be an array')
  if (f.thresholds !== undefined && !isObject(f.thresholds)) issues.push('"thresholds" must be an object')
  if (f.resumption_targets !== undefined && !isObject(f.resumption_targets))
    issues.push('"resumption_targets" must be an object')
  return issues
}

export function parseFragment(raw: string, source = 'fragment'): WorkflowFragment {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (err) {
    throw new WorkflowError(`${source} is not valid JSON: ${(err as Error).message}`)
  }
  const issues = validateFragment(data)
  if (issues.length) throw new WorkflowError(`${source} is not a valid workflow fragment`, issues)
  return data as WorkflowFragment
}

interface Piece<T> {
  label: string
  data: T
}

/**
 * Merge pieces in order. States, transitions, triggers, global transitions and
 * actions accumulate; thresholds, resumption targets and initial_state must
 * agree. The first piece to mention a state defines it; a later piece may add
 * transitions and triggers to it but not a description, so two pieces never
 * both claim a state. Throws a WorkflowError naming both files on every conflict.
 */
export function mergeWorkflows(
  base: Piece<Workflow> | null,
  fragments: Piece<WorkflowFragment>[],
): { workflow: Workflow; origin: WorkflowOrigin } {
  const issues: string[] = []
  const origin: WorkflowOrigin = { states: {}, events: {}, thresholds: {} }
  const globalEvents: Record<string, string> = {}
  const from: Record<string, string> = {} // initial_state and resumption_targets owners
  const out: Workflow = { states: {} }
  const pieces: Piece<WorkflowFragment>[] = base ? [base, ...fragments] : fragments
  if (base) {
    const { $schema, name, version, description, config } = base.data
    if ($schema !== undefined) out.$schema = $schema
    if (name !== undefined) out.name = name
    if (version !== undefined) out.version = version
    if (description !== undefined) out.description = description
    if (config !== undefined) out.config = config
  }
  for (const { label, data } of pieces) {
    for (const [name, state] of Object.entries(data.states ?? {})) {
      const existing = out.states[name]
      if (!existing) {
        const copy: State = { ...state }
        if (state.transitions) copy.transitions = [...state.transitions]
        if (state.triggers) copy.triggers = [...state.triggers]
        out.states[name] = copy
        origin.states[name] = label
      } else {
        if (state.description !== undefined)
          issues.push(
            `${label}: state "${name}" is already defined in ${origin.states[name]}; a later piece may add transitions and triggers to it, not a description`,
          )
        if (state.transitions?.length) existing.transitions = [...(existing.transitions ?? []), ...state.transitions]
        if (state.triggers?.length) existing.triggers = [...(existing.triggers ?? []), ...state.triggers]
      }
      for (const t of state.transitions ?? []) {
        const key = `${name} ${t.event}`
        if (origin.events[key])
          issues.push(`${label}: state "${name}" event "${t.event}" is already defined in ${origin.events[key]}`)
        else origin.events[key] = label
      }
    }
    for (const g of data.global_transitions ?? []) {
      if (globalEvents[g.event])
        issues.push(`${label}: global event "${g.event}" is already defined in ${globalEvents[g.event]}`)
      else globalEvents[g.event] = label
      out.global_transitions ??= []
      out.global_transitions.push(g)
    }
    for (const a of data.global_actions ?? []) {
      out.global_actions ??= []
      if (!out.global_actions.includes(a)) out.global_actions.push(a)
    }
    for (const [k, v] of Object.entries(data.thresholds ?? {})) {
      if (origin.thresholds[k] && out.thresholds?.[k] !== v)
        issues.push(`${label}: threshold "${k}" = ${v} disagrees with ${origin.thresholds[k]} (${out.thresholds?.[k]})`)
      else {
        out.thresholds ??= {}
        out.thresholds[k] = v
        origin.thresholds[k] ??= label
      }
    }
    for (const [k, v] of Object.entries(data.resumption_targets ?? {})) {
      const owner = from[`resume ${k}`]
      if (owner && out.resumption_targets?.[k] !== v)
        issues.push(
          `${label}: resumption target "${k}" → "${v}" disagrees with ${owner} ("${out.resumption_targets?.[k]}")`,
        )
      else {
        out.resumption_targets ??= {}
        out.resumption_targets[k] = v
        from[`resume ${k}`] ??= label
      }
    }
    if (data.initial_state !== undefined) {
      if (out.initial_state !== undefined && out.initial_state !== data.initial_state)
        issues.push(
          `${label}: initial_state "${data.initial_state}" disagrees with ${from.initial_state} ("${out.initial_state}")`,
        )
      else {
        out.initial_state = data.initial_state
        from.initial_state ??= label
      }
    }
  }
  if (issues.length) throw new WorkflowError('workflow fragments do not merge', issues)
  return { workflow: out, origin }
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
