import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { TokenUsage } from '../shared/types.js'

// Claude Code writes each conversation to ~/.claude/projects/<folder>/<session id>.jsonl,
// one line per message, every assistant line carrying the API's usage for that request.
// The page asks every few seconds, so nothing here may walk all of that on each ask:
// the folders are indexed at most every INDEX_MS, and a transcript is read only past
// where the last read stopped.
const PROJECTS = join(homedir(), '.claude', 'projects')
const INDEX_MS = 30_000

let index = new Map<string, string>()
let indexedAt = 0

function reindex() {
  const next = new Map<string, string>()
  if (existsSync(PROJECTS)) {
    for (const folder of readdirSync(PROJECTS)) {
      let names: string[]
      try {
        names = readdirSync(join(PROJECTS, folder))
      } catch {
        continue
      }
      for (const name of names) if (name.endsWith('.jsonl')) next.set(name.slice(0, -6), join(PROJECTS, folder, name))
    }
  }
  index = next
  indexedAt = Date.now()
}

function locate(sessionId: string): string | undefined {
  const known = index.get(sessionId)
  if (known) return known
  // A session nobody has written yet stays unknown until the next index, not a rescan per ask.
  if (Date.now() - indexedAt > INDEX_MS) reindex()
  return index.get(sessionId)
}

type Line = {
  type?: string
  requestId?: string
  timestamp?: string
  message?: {
    id?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
}

type Tally = {
  usage: TokenUsage
  /** Bytes read so far, and an unfinished last line held until its end is written. */
  offset: number
  partial: string
  seen: Set<string>
  dayStart: number
}

const tallies = new Map<string, Tally>()

const fresh = (): Tally => ({
  usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, today: 0 },
  offset: 0,
  partial: '',
  seen: new Set(),
  dayStart: new Date().setHours(0, 0, 0, 0),
})

function count(tally: Tally, raw: string) {
  if (!raw.includes('"usage"')) return
  let line: Line
  try {
    line = JSON.parse(raw) as Line
  } catch {
    return
  }
  const u = line.message?.usage
  if (line.type !== 'assistant' || !u) return
  // One response can span several lines (one per content block), each repeating its usage.
  const key = line.requestId ?? line.message?.id
  if (key) {
    if (tally.seen.has(key)) return
    tally.seen.add(key)
  }
  const { usage } = tally
  const input = u.input_tokens ?? 0
  const cacheWrite = u.cache_creation_input_tokens ?? 0
  const output = u.output_tokens ?? 0
  usage.input += input
  usage.cacheWrite += cacheWrite
  usage.cacheRead += u.cache_read_input_tokens ?? 0
  usage.output += output
  usage.turns += 1
  if (line.timestamp && Date.parse(line.timestamp) >= tally.dayStart) usage.today += input + cacheWrite + output
  if (line.timestamp) usage.lastAt = line.timestamp
}

/** Reads whatever the transcript gained since the last read. */
function catchUp(file: string, tally: Tally, size: number) {
  const length = size - tally.offset
  if (length <= 0) return
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, length, tally.offset)
  } finally {
    closeSync(fd)
  }
  tally.offset = size
  const lines = (tally.partial + buffer.toString('utf8')).split('\n')
  tally.partial = lines.pop() ?? ''
  for (const raw of lines) count(tally, raw)
}

/** Token usage of one Claude Code session, read from its transcript as it grows. */
export function sessionUsage(sessionId: string): TokenUsage | undefined {
  const file = locate(sessionId)
  if (!file) return undefined
  let size: number
  try {
    size = statSync(file).size
  } catch {
    index.delete(sessionId)
    return undefined
  }
  let tally = tallies.get(file)
  // A file that shrank was rewritten, and a new day resets "today": both start the count over.
  if (!tally || size < tally.offset || tally.dayStart !== new Date().setHours(0, 0, 0, 0)) {
    tally = fresh()
    tallies.set(file, tally)
  }
  catchUp(file, tally, size)

  return tally.usage
}

/**
 * Whether Claude Code has written this session's conversation, so `--resume` can load it.
 * `isExact` looks again right now: deciding to resume must not miss a transcript the index has not seen yet.
 */
export function hasTranscript(sessionId: string, isExact = false): boolean {
  if (locate(sessionId)) return true
  if (!isExact) return false
  reindex()
  return index.has(sessionId)
}
