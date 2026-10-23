import { type ConfigInput, resolveConfig, resolveRoot, stateFilePath } from './config.js'
import { appendLog, readLog } from './log.js'
import { readState, writeState } from './state.js'
import type { CheckContext, LogEntry, ResolvedConfig, StateData, Workflow } from './types.js'
import { WorkflowGraph, loadWorkflow } from './workflow.js'

export interface EngineOptions extends ConfigInput {
  /** Supply the workflow directly instead of reading `workflowPath`. Tests and embedders use this. */
  workflow?: string
  workflowData?: Workflow
}

export interface CurrentState {
  path: string
  data: StateData
  /** The state name, from the file or from `initial_state` when the file has none. */
  state: string | null
  /** True when the state came from `initial_state`, not the file. */
  initial: boolean
  exists: boolean
}

/** One workflow, one project root: the object every tool handler works against. */
export class Engine {
  readonly config: ResolvedConfig
  readonly graph: WorkflowGraph

  constructor(config: ResolvedConfig, workflow: Workflow) {
    this.config = config
    this.graph = new WorkflowGraph(workflow)
  }

  get workflow(): Workflow {
    return this.graph.workflow
  }

  stateFile(projectPath?: string): string {
    return stateFilePath(this.config, projectPath)
  }

  /** Read the state file and name the current state, falling back to `initial_state`. */
  current(projectPath?: string): CurrentState {
    const path = this.stateFile(projectPath)
    const existing = readState(path)
    const data = existing ?? {}
    const fromFile = data[this.config.stateField]
    if (typeof fromFile === 'string' && fromFile) {
      return { path, data, state: fromFile, initial: false, exists: existing !== null }
    }
    return { path, data, state: this.graph.initialState(), initial: true, exists: existing !== null }
  }

  previousState(data: StateData, context?: CheckContext): string | undefined {
    const fromData = data[this.config.previousStateField]
    if (typeof fromData === 'string') return fromData
    const fromContext =
      context?.[this.config.previousStateField] ?? context?.previous_workflow_state ?? context?.previous_state
    return typeof fromContext === 'string' ? fromContext : undefined
  }

  writeState(path: string, data: StateData): void {
    writeState(path, data)
  }

  log(entry: Omit<LogEntry, 'timestamp'>): void {
    appendLog(this.config.logFile, entry)
  }

  history(): LogEntry[] {
    return readLog(this.config.logFile)
  }
}

/** Resolve the root, load and validate the workflow, then resolve the rest of the config from it. */
export function createEngine(options: EngineOptions = {}): Engine {
  const { workflowPath } = resolveRoot(options)
  const workflow = options.workflowData ?? loadWorkflow(workflowPath)
  const config = resolveConfig(options, workflow.config ?? {})
  return new Engine(config, workflow)
}
