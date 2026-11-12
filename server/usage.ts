import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { TokenUsage } from '../shared/types.js'

// Claude Code writes each conversation to ~/.claude/projects/<folder>/<session id>.jsonl,
// one line per message, every assistant line carrying the API's usage for that request.
const PROJECTS = join(homedir(), '.claude', 'projects')

const located = new Map<string, string>()
const cached = new Map<string, { mtimeMs: number; usage: TokenUsage }>()

function locate(sessionId: string): string | undefined {
  const known = located.get(sessionId)
  if (known && existsSync(known)) return known
  if (!existsSync(PROJECTS)) return undefined
  for (const folder of readdirSync(PROJECTS)) {
    const file = join(PROJECTS, folder, `${sessionId}.jsonl`)
    if (existsSync(file)) {
      located.set(sessionId, file)
      return file
    }
  }

  return undefined
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

const empty = (): TokenUsage => ({ input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, today: 0 })

function read(file: string): TokenUsage {
  const usage = empty()
  const seen = new Set<string>()
  const startOfDay = new Date().setHours(0, 0, 0, 0)

  for (const raw of readFileSync(file, 'utf8').split('\n')) {
    if (!raw.includes('"usage"')) continue
    let line: Line
    try {
      line = JSON.parse(raw) as Line
    } catch {
      continue
    }
    const u = line.message?.usage
    if (line.type !== 'assistant' || !u) continue
    // One response can span several lines (one per content block), each repeating its usage.
    const key = line.requestId ?? line.message?.id
    if (key) {
      if (seen.has(key)) continue
      seen.add(key)
    }
    const input = u.input_tokens ?? 0
    const cacheWrite = u.cache_creation_input_tokens ?? 0
    const output = u.output_tokens ?? 0
    usage.input += input
    usage.cacheWrite += cacheWrite
    usage.cacheRead += u.cache_read_input_tokens ?? 0
    usage.output += output
    usage.turns += 1
    if (line.timestamp && Date.parse(line.timestamp) >= startOfDay) usage.today += input + cacheWrite + output
    if (line.timestamp) usage.lastAt = line.timestamp
  }

  return usage
}

/** Token usage of one Claude Code session, read from its transcript; re-read only when the file changes. */
export function sessionUsage(sessionId: string): TokenUsage | undefined {
  const file = locate(sessionId)
  if (!file) return undefined
  const { mtimeMs } = statSync(file)
  const hit = cached.get(file)
  if (hit && hit.mtimeMs === mtimeMs) return hit.usage
  const usage = read(file)
  cached.set(file, { mtimeMs, usage })

  return usage
}

/** Whether Claude Code has written this session's conversation, so `--resume` can load it. */
export const hasTranscript = (sessionId: string) => locate(sessionId) !== undefined
