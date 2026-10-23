/** A state-specific transition. `target: null` resolves from `resumption_targets[previous state]` at run time. */
export interface Transition {
  event: string
  target: string | null
  action?: string | null
  /** The agent evaluates a condition before choosing this transition. */
  judgment?: boolean
  description?: string | null
}

/** A transition available from every state not listed in `except`. */
export interface GlobalTransition extends Transition {
  except?: string[]
}

/**
 * An automatic transition. `condition` is `always`, or `<path> <op> <path|number>`
 * where paths are dotted lookups into the check context, with `thresholds.*`
 * resolving to the workflow's thresholds.
 */
export interface Trigger {
  condition: string
  target: string | null
  action?: string | null
  description?: string | null
}

export interface State {
  description?: string
  transitions?: Transition[]
  triggers?: Trigger[]
}

/** Where a workflow keeps its state and log, relative to the project directory. */
export interface WorkflowConfig {
  state_file?: string
  log_file?: string
  state_field?: string
  previous_state_field?: string
}

export interface Workflow {
  $schema?: string
  name?: string
  version?: number
  description?: string
  initial_state?: string
  states: Record<string, State>
  global_transitions?: GlobalTransition[]
  global_actions?: string[]
  thresholds?: Record<string, number>
  resumption_targets?: Record<string, string>
  config?: WorkflowConfig
}

export interface ResolvedConfig {
  /** The project root every relative path resolves against. */
  root: string
  workflowPath: string
  /** Relative to the project directory (root, or root/project_path), or absolute. */
  stateFile: string
  /** Absolute. */
  logFile: string
  stateField: string
  previousStateField: string
}

export type StateData = Record<string, unknown>

export interface CheckContext {
  [key: string]: unknown
  previous_workflow_state?: string
  previous_state?: string
}

export interface LogEntry {
  timestamp: string
  type: 'transition' | 'judgment' | 'trigger'
  [key: string]: unknown
}
