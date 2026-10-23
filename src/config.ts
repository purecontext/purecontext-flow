import { resolve } from 'node:path'
import type { ResolvedConfig, WorkflowConfig } from './types.js'

export const DEFAULTS = {
  workflow: '.forge/workflow.json',
  stateFile: '.forge/dev-state.json',
  logFile: '.forge/flow-log.jsonl',
  stateField: 'workflow_state',
} as const

export interface ConfigInput {
  root?: string
  workflow?: string
  stateFile?: string
  logFile?: string
  stateField?: string
  previousStateField?: string
  env?: NodeJS.ProcessEnv
  cwd?: string
}

/** Root and workflow path: everything that can be known before the workflow is read. */
export function resolveRoot(input: ConfigInput = {}): { root: string; workflowPath: string } {
  const env = input.env ?? process.env
  const root = resolve(input.root ?? env.FLOW_ROOT ?? env.FLOW_PROJECT_PATH ?? input.cwd ?? process.cwd())
  const workflowPath = resolve(root, input.workflow ?? env.FLOW_WORKFLOW ?? DEFAULTS.workflow)
  return { root, workflowPath }
}

/**
 * Full configuration. Precedence: explicit input, then FLOW_* environment, then
 * the workflow's own `config` block, then defaults.
 */
export function resolveConfig(input: ConfigInput = {}, workflowConfig: WorkflowConfig = {}): ResolvedConfig {
  const env = input.env ?? process.env
  const { root, workflowPath } = resolveRoot(input)
  const stateField = input.stateField ?? env.FLOW_STATE_FIELD ?? workflowConfig.state_field ?? DEFAULTS.stateField
  return {
    root,
    workflowPath,
    stateFile: input.stateFile ?? env.FLOW_STATE_FILE ?? workflowConfig.state_file ?? DEFAULTS.stateFile,
    logFile: resolve(root, input.logFile ?? env.FLOW_LOG_FILE ?? workflowConfig.log_file ?? DEFAULTS.logFile),
    stateField,
    previousStateField:
      input.previousStateField ??
      env.FLOW_PREVIOUS_STATE_FIELD ??
      workflowConfig.previous_state_field ??
      `previous_${stateField}`,
  }
}

/** The state file for the root, or for a project directory under it. */
export function stateFilePath(config: ResolvedConfig, projectPath?: string): string {
  const dir = projectPath ? resolve(config.root, projectPath) : config.root
  return resolve(dir, config.stateFile)
}
