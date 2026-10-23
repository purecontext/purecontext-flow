const PATH = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`
const NUMBER = String.raw`-?\d+(?:\.\d+)?`
const CONDITION = new RegExp(`^(${PATH})\\s*(>=|<=|==|!=|>|<)\\s*(${PATH}|${NUMBER})$`)

export type Operator = '>=' | '<=' | '==' | '!=' | '>' | '<'

export type ParsedCondition =
  | { kind: 'always' }
  | { kind: 'compare'; left: string; op: Operator; right: { path: string } | { value: number } }

/** Parse a trigger condition. Returns null when the text is not a condition this engine understands. */
export function parseCondition(condition: string): ParsedCondition | null {
  const text = condition.trim()
  if (text === 'always') return { kind: 'always' }
  const m = CONDITION.exec(text)
  if (!m) return null
  const [, left, op, right] = m
  const asNumber = Number(right)
  return {
    kind: 'compare',
    left,
    op: op as Operator,
    right: /^-?\d/.test(right) && Number.isFinite(asNumber) ? { value: asNumber } : { path: right },
  }
}

export function lookup(scope: Record<string, unknown>, path: string): unknown {
  let current: unknown = scope
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/**
 * Evaluate a condition against a scope. A left side whose parent object exists but
 * whose leaf is missing counts as 0 (counters start at zero). A left side whose
 * parent is missing, or a missing right side, makes the condition unresolvable
 * (null), so a typo in a path cannot fire a trigger forever or silence it.
 */
export function evaluateCondition(condition: string, scope: Record<string, unknown>): boolean | null {
  const parsed = parseCondition(condition)
  if (!parsed) return null
  if (parsed.kind === 'always') return true
  const leftRaw = lookup(scope, parsed.left)
  if (leftRaw === undefined || leftRaw === null) {
    const parentPath = parsed.left.split('.').slice(0, -1).join('.')
    const parent = parentPath ? lookup(scope, parentPath) : scope
    if (parent === undefined || parent === null || typeof parent !== 'object') return null
  }
  const left = typeof leftRaw === 'number' ? leftRaw : leftRaw === undefined || leftRaw === null ? 0 : Number(leftRaw)
  const rightRaw = 'value' in parsed.right ? parsed.right.value : lookup(scope, parsed.right.path)
  if (rightRaw === undefined || rightRaw === null) return null
  const right = Number(rightRaw)
  if (!Number.isFinite(left) || !Number.isFinite(right)) return null
  switch (parsed.op) {
    case '>=':
      return left >= right
    case '<=':
      return left <= right
    case '==':
      return left === right
    case '!=':
      return left !== right
    case '>':
      return left > right
    case '<':
      return left < right
  }
}
