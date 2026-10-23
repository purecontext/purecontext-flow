import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { LogEntry } from './types.js'

export function appendLog(path: string, entry: Omit<LogEntry, 'timestamp'>): void {
  mkdirSync(dirname(path), { recursive: true })
  appendFileSync(path, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, 'utf8')
}

/** Every parseable line of the log, oldest first. */
export function readLog(path: string): LogEntry[] {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8').trim()
  if (!raw) return []
  const entries: LogEntry[] = []
  for (const line of raw.split('\n')) {
    try {
      entries.push(JSON.parse(line) as LogEntry)
    } catch {
      // A torn line from a crashed write is skipped, not fatal.
    }
  }
  return entries
}
