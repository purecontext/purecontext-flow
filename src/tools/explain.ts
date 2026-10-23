import type { Engine } from '../engine.js'

export const schema = {
  name: 'flow_explain',
  description:
    'Trace the workflow graph: the shortest path from one state to another, or everything reachable from a state. Transitions and triggers both count as edges.',
  inputSchema: {
    type: 'object',
    properties: {
      from_state: { type: 'string', description: 'Starting state.' },
      to_state: { type: 'string', description: 'Target state. Omit to list every reachable state.' },
      max_depth: { type: 'number', description: 'Search depth limit (default 10).' },
    },
    required: ['from_state'],
  },
} as const

export interface ExplainArgs {
  from_state: string
  to_state?: string
  max_depth?: number
}

interface Step {
  from: string
  to: string
  via: string
  action: string | null
  judgment: boolean
  description: string | null
}

export function handler(engine: Engine, { from_state, to_state, max_depth }: ExplainArgs) {
  const { graph } = engine
  const limit = max_depth ?? 10
  if (!graph.state(from_state)) return { error: `Unknown state: "${from_state}"`, valid_states: graph.stateNames() }
  if (to_state && !graph.state(to_state))
    return { error: `Unknown state: "${to_state}"`, valid_states: graph.stateNames() }

  const edges = (state: string): Step[] => [
    ...graph
      .availableTransitions(state)
      .filter((t) => t.target !== null)
      .map((t) => ({
        from: state,
        to: t.target as string,
        via: t.global ? `${t.event} (global)` : t.event,
        action: t.action ?? null,
        judgment: t.judgment ?? false,
        description: t.description ?? null,
      })),
    ...graph
      .triggers(state)
      .filter((t) => t.target !== null)
      .map((t) => ({
        from: state,
        to: t.target as string,
        via: `trigger: ${t.condition}`,
        action: t.action ?? null,
        judgment: false,
        description: t.description ?? null,
      })),
  ]

  if (to_state) {
    const queue: { state: string; path: Step[] }[] = [{ state: from_state, path: [] }]
    const visited = new Set([from_state])
    while (queue.length) {
      const { state, path } = queue.shift() as { state: string; path: Step[] }
      if (path.length >= limit) continue
      for (const step of edges(state)) {
        if (step.to === to_state) {
          return { found: true, from_state, to_state, steps: [...path, step], total_hops: path.length + 1 }
        }
        if (!visited.has(step.to)) {
          visited.add(step.to)
          queue.push({ state: step.to, path: [...path, step] })
        }
      }
    }
    return {
      found: false,
      from_state,
      to_state,
      message: `No path from "${from_state}" to "${to_state}" within ${limit} hops`,
      reachable_states: [...visited],
    }
  }

  const reachable = new Map<string, { depth: number; via: string; action?: string | null; judgment?: boolean }>()
  reachable.set(from_state, { depth: 0, via: 'entry' })
  const queue: { state: string; depth: number }[] = [{ state: from_state, depth: 0 }]
  while (queue.length) {
    const { state, depth } = queue.shift() as { state: string; depth: number }
    if (depth >= limit) continue
    for (const step of edges(state)) {
      if (reachable.has(step.to)) continue
      reachable.set(step.to, {
        depth: depth + 1,
        via: `${state} → ${step.via}`,
        action: step.action,
        judgment: step.judgment,
      })
      queue.push({ state: step.to, depth: depth + 1 })
    }
  }
  const states = [...reachable].map(([state, info]) => ({
    state,
    description: graph.state(state)?.description ?? null,
    ...info,
  }))
  return {
    from_state,
    reachable_count: states.length,
    max_depth: limit,
    global_actions: graph.globalActions(),
    states: states.sort((a, b) => a.depth - b.depth),
  }
}
