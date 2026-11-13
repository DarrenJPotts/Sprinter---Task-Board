import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { BgTask, TokenUsage } from '../shared/types.js'

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

/** The transcript file of a Claude session, if Claude has written one. */
export function locate(sessionId: string): string | undefined {
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
  /** Background tasks by the tool call that started them. */
  tasks: Map<string, BgTask>
  /** A task id from its start, mapped to the tool call, so a completion notice finds its task. */
  taskIds: Map<string, string>
  /** Time spent in the chat, and the time of its last line. */
  activeMs: number
  lastLineAt: number
}

const tallies = new Map<string, Tally>()

const fresh = (): Tally => ({
  usage: { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, turns: 0, today: 0 },
  offset: 0,
  partial: '',
  seen: new Set(),
  dayStart: new Date().setHours(0, 0, 0, 0),
  tasks: new Map(),
  taskIds: new Map(),
  activeMs: 0,
  lastLineAt: 0,
})

// A pause longer than this between two lines of a chat is a break, not work, so it is not counted.
const BREAK_MS = 5 * 60_000

/** Adds the gap since the chat's previous line, when it is short enough to be one stretch of work. */
function clock(tally: Tally, raw: string) {
  const stamp = /"timestamp":"([^"]+)"/.exec(raw)?.[1]
  const at = stamp ? Date.parse(stamp) : NaN
  if (!Number.isFinite(at)) return
  const gap = at - tally.lastLineAt
  if (tally.lastLineAt > 0 && gap > 0 && gap <= BREAK_MS) tally.activeMs += gap
  if (at > tally.lastLineAt) tally.lastLineAt = at
}

function count(tally: Tally, raw: string) {
  clock(tally, raw)
  // A cheap test before parsing: only these lines start, name, resume, stop or finish background work.
  if (/run_in_background|backgroundTaskId|agentId|task-notification|TaskStop|SendMessage/.test(raw)) track(tally, raw)
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

type ToolUse = { type?: string; id?: string; name?: string; input?: { run_in_background?: boolean; description?: string; command?: string; prompt?: string; task_id?: string; to?: string } }
type ToolResult = { type?: string; tool_use_id?: string; content?: unknown }
type TaskLine = {
  type?: string
  timestamp?: string
  message?: { content?: unknown }
  toolUseResult?: { backgroundTaskId?: string; agentId?: string }
}

// The parts of a completion notice: <task-id>, <tool-use-id>, <output-file>, <status>, <summary>.
const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim()

/** The first string anywhere in a parsed line that holds a completion notice. */
function noticeIn(value: unknown): string | undefined {
  if (typeof value === 'string') return value.includes('<task-notification>') ? value : undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = noticeIn(item)
      if (found) return found
    }
  } else if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      const found = noticeIn(item)
      if (found) return found
    }
  }
  return undefined
}

/** Background work in one transcript line: a task started, its id handed back, or its completion notice. */
function track(tally: Tally, raw: string) {
  let line: TaskLine
  try {
    line = JSON.parse(raw) as TaskLine
  } catch {
    return
  }
  const blocks = Array.isArray(line.message?.content) ? (line.message!.content as (ToolUse & ToolResult)[]) : []
  for (const block of blocks) {
    if (block.type === 'tool_use' && block.id && block.input?.run_in_background) {
      const isAgent = block.name === 'Agent' || block.name === 'Task'
      tally.tasks.set(block.id, {
        id: block.id,
        kind: isAgent ? 'agent' : 'shell',
        description: block.input.description || (block.input.command ?? block.input.prompt ?? block.name ?? 'task').slice(0, 120),
        status: 'running',
        startedAt: line.timestamp,
      })
    }
    // A stop sends no completion notice of its own: the stop call is the record.
    if (block.type === 'tool_use' && block.name === 'TaskStop' && block.input?.task_id) {
      const stopped = tally.tasks.get(tally.taskIds.get(block.input.task_id) ?? '')
      if (stopped && stopped.status === 'running') {
        stopped.status = 'stopped'
        stopped.endedAt = line.timestamp
      }
    }
    // Messaging a finished or interrupted agent sets it working again, under the same agent id.
    if (block.type === 'tool_use' && block.name === 'SendMessage' && block.input?.to) {
      const resumed = tally.tasks.get(tally.taskIds.get(block.input.to) ?? '')
      if (resumed) {
        resumed.status = 'running'
        resumed.resumedAt = line.timestamp
        resumed.endedAt = undefined
        resumed.summary = undefined
      }
    }
    if (block.type === 'tool_result' && block.tool_use_id) {
      const task = tally.tasks.get(block.tool_use_id)
      const id = line.toolUseResult?.backgroundTaskId ?? line.toolUseResult?.agentId
      if (task && id) tally.taskIds.set(id, block.tool_use_id)
      const text = typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
      const file = /written to: (.+?\.output)/.exec(text)?.[1]
      if (task && file) task.outputFile = file
    }
  }
  // A notice can sit in a queue record or an attachment; its text is the same either way.
  const text = raw.includes('task-notification') ? noticeIn(line) : undefined
  if (!text) return
  // A resumed agent's notice names the SendMessage call, not the call that started it, so the agent id
  // is the fallback.
  const task = tally.tasks.get(tag(text, 'tool-use-id') ?? '') ?? tally.tasks.get(tally.taskIds.get(tag(text, 'task-id') ?? '') ?? '')
  if (!task) return
  task.status = tag(text, 'status') ?? task.status
  task.summary = tag(text, 'summary') ?? task.summary
  task.outputFile = tag(text, 'output-file') ?? task.outputFile
  if (line.timestamp && task.status !== 'running') task.endedAt = line.timestamp
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

/** A session's transcript, read up to now: its token use and its background tasks. */
function tallyOf(sessionId: string): Tally | undefined {
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

  return tally
}

/** Time worked in one Claude Code session: the gaps between its lines, leaving out breaks. */
export const sessionActiveMs = (sessionId: string): number => tallyOf(sessionId)?.activeMs ?? 0

/** Token usage of one Claude Code session, read from its transcript as it grows. */
export const sessionUsage = (sessionId: string): TokenUsage | undefined => tallyOf(sessionId)?.usage

/** A session's background tasks, newest first. */
export const sessionTasks = (sessionId: string): BgTask[] =>
  [...(tallyOf(sessionId)?.tasks.values() ?? [])].sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))

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
