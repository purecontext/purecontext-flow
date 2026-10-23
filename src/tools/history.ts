import type { Engine } from '../engine.js'
import type { LogEntry } from '../types.js'

export const schema = {
  name: 'flow_history',
  description:
    'Query the transition, judgment and trigger log. "recent" returns the last N entries, "filter" the first N matching entries, "summary" aggregate counts and judgment conditions that always resolve the same way.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['recent', 'filter', 'summary'], description: 'Default: recent.' },
      limit: { type: 'number', description: 'Max entries (default 20).' },
      type: { type: 'string', enum: ['transition', 'judgment', 'trigger'] },
      state: { type: 'string', description: 'Match from_state or state.' },
      since: { type: 'string', description: 'ISO timestamp; only entries at or after it.' },
    },
  },
} as const

export interface HistoryArgs {
  mode?: 'recent' | 'filter' | 'summary'
  limit?: number
  type?: LogEntry['type']
  state?: string
  since?: string
}

export function handler(engine: Engine, { mode, limit, type, state, since }: HistoryArgs) {
  const entries = engine.history()
  if (entries.length === 0) {
    return {
      message: `No entries yet in ${engine.config.logFile}. The log fills as flow_transition and flow_check run.`,
      total_entries: 0,
    }
  }
  const queryMode = mode ?? 'recent'
  const max = limit ?? 20
  if (queryMode === 'summary') return summarize(entries)

  let filtered = entries
  if (type) filtered = filtered.filter((e) => e.type === type)
  if (state) filtered = filtered.filter((e) => e.from_state === state || e.state === state)
  if (since) {
    const cutoff = new Date(since).getTime()
    filtered = filtered.filter((e) => new Date(e.timestamp).getTime() >= cutoff)
  }
  filtered = queryMode === 'recent' ? filtered.slice(-max) : filtered.slice(0, max)
  return {
    mode: queryMode,
    total_in_log: entries.length,
    returned: filtered.length,
    filters: { type: type ?? null, state: state ?? null, since: since ?? null },
    entries: filtered,
  }
}

function summarize(entries: LogEntry[]) {
  const byType: Record<string, number> = {}
  const byState: Record<string, number> = {}
  const judgments: LogEntry[] = []
  for (const e of entries) {
    byType[e.type] = (byType[e.type] ?? 0) + 1
    const key = String(e.from_state ?? e.state ?? 'unknown')
    byState[key] = (byState[key] ?? 0) + 1
    if (e.type === 'judgment') judgments.push(e)
  }
  return {
    mode: 'summary',
    total_entries: entries.length,
    time_range: { first: entries[0]?.timestamp, last: entries[entries.length - 1]?.timestamp },
    by_type: byType,
    by_state: byState,
    judgment_analysis: analyzeJudgments(judgments),
  }
}

function analyzeJudgments(judgments: LogEntry[]) {
  if (judgments.length === 0) return { total: 0, message: 'No judgment entries yet.' }
  const byCondition: Record<string, { true_count: number; false_count: number; total: number }> = {}
  for (const j of judgments) {
    const key = String(j.condition ?? 'unknown')
    byCondition[key] ??= { true_count: 0, false_count: 0, total: 0 }
    const stats = byCondition[key]
    stats.total++
    if (j.result) stats.true_count++
    else stats.false_count++
  }
  const candidates = Object.entries(byCondition)
    .filter(([, s]) => s.total >= 3 && (s.true_count === 0 || s.false_count === 0))
    .map(([condition, s]) => ({
      condition,
      always: s.true_count > 0 ? 'true' : 'false',
      count: s.total,
      suggestion: `This condition is always ${s.true_count > 0 ? 'true' : 'false'}; consider making it deterministic and dropping the judgment`,
    }))
  return {
    total: judgments.length,
    by_condition: byCondition,
    optimization_candidates: candidates.length ? candidates : null,
  }
}
