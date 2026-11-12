import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import type { Board, Prefs } from '../shared/types.js'

/** What a project keeps between runs: saved moves, stars, each ticket's Claude session, the last board. */
export type Saved = {
  prefs: Prefs
  /** Claude Code session id per terminal key, so a ticket's terminal resumes its conversation. */
  sessions: Record<string, string>
  board: Board | null
}

const EMPTY: Saved = { prefs: { when: {}, pinned: [] }, sessions: {}, board: null }

export function loadSaved(dataDir: string): Saved {
  const file = join(dataDir, 'state.json')
  if (!existsSync(file)) return structuredClone(EMPTY)
  try {
    return { ...structuredClone(EMPTY), ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<Saved>) }
  } catch {
    return structuredClone(EMPTY)
  }
}

export function save(dataDir: string, saved: Saved) {
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'state.json'), JSON.stringify(saved, null, 2))
}
