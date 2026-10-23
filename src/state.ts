import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { StateData } from './types.js'

/** The parsed state file, or null when it does not exist yet. */
export function readState(path: string): StateData | null {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw err
  }
  const data = JSON.parse(raw) as unknown
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error(`${path} must hold a JSON object`)
  }
  return data as StateData
}

export function writeState(path: string, data: StateData): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}
