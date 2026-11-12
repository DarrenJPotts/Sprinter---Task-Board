import type { LogEntry } from '../shared/types.js'

const KEEP = 100
const entries: LogEntry[] = []

/** Records a server-side failure for the app's debug log, and echoes it to the console. */
export function logError(source: string, caught: unknown) {
  const message = caught instanceof Error ? caught.message : String(caught)
  entries.push({ at: Date.now(), side: 'server', source, message })
  if (entries.length > KEEP) entries.splice(0, entries.length - KEEP)
  console.error(`[${source}] ${message}`)
}

export const serverLog = () => [...entries]

export function clearServerLog() {
  entries.length = 0
}
