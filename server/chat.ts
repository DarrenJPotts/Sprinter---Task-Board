import { type FSWatcher, closeSync, openSync, readSync, statSync, watch } from 'node:fs'

import type { ChatItem, ChatPage } from '../shared/types.js'
import { locate } from './usage.js'

// The first read of a long chat shows its latest part only; the page asks for the rest as it grows.
const FIRST_READ = 3_000_000
const RESULT_MAX = 2_000

type Block = {
  type?: string
  text?: string
  id?: string
  name?: string
  input?: Record<string, unknown>
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}
type Line = {
  type?: string
  uuid?: string
  timestamp?: string
  isMeta?: boolean
  isSidechain?: boolean
  isCompactSummary?: boolean
  message?: { role?: string; content?: string | Block[] }
  attachment?: { type?: string; prompt?: unknown }
}

const tag = (text: string, name: string) => new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text)?.[1]?.trim()
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

// Reminders and other wrapped context the harness adds around a prompt are not what the person typed.
const stripWrapped = (text: string) => text.replace(/<(system-reminder|local-command-caveat)>[\s\S]*?<\/\1>/g, '').trim()

/** What a person typed, or undefined when the text is harness traffic (notices, hand-backs, hook output). */
function typed(text: string): string | undefined {
  const command = tag(text, 'command-name')
  if (command) return [command, tag(text, 'command-args')].filter(Boolean).join(' ')
  const clean = stripWrapped(text)
  if (!clean || clean.startsWith('<')) return undefined
  return clean
}

/** One line for a tool call: the part of its input a person would recognise it by. */
function summarise(name: string, input: Record<string, unknown> = {}): string {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  const firstLine = (text: string) => text.split('\n')[0] ?? ''
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return str('description') || clip(firstLine(str('command')), 160)
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit':
      return str('file_path') || str('notebook_path')
    case 'Grep':
    case 'Glob':
      return [str('pattern'), str('path')].filter(Boolean).join(' in ')
    case 'Agent':
    case 'Task':
      return str('description')
    case 'Skill':
      return [str('skill'), str('args')].filter(Boolean).join(' ')
    case 'WebFetch':
      return str('url')
    case 'WebSearch':
      return str('query')
    case 'SendMessage':
      return str('summary') || clip(str('message'), 120)
    default: {
      const first = Object.values(input).find(value => typeof value === 'string') as string | undefined
      return clip(firstLine(first ?? ''), 160)
    }
  }
}

const resultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map(part => (part && typeof part === 'object' && 'text' in part ? String((part as { text: unknown }).text) : part?.type === 'image' ? '[image]' : ''))
      .join('\n')
  return ''
}

/** The chat items in one transcript line. */
function itemsOf(line: Line, at: number): ChatItem[] {
  if (line.isSidechain) return []
  const id = line.uuid ?? `@${at}`
  const when = line.timestamp

  if (line.isCompactSummary) return [{ kind: 'notice', id, at: when, text: 'Earlier conversation was compacted into a summary.' }]

  // A prompt typed while Claude was busy waits in a queue and lands as an attachment.
  if (line.type === 'attachment' && line.attachment?.type === 'queued_command' && typeof line.attachment.prompt === 'string') {
    const prompt = line.attachment.prompt
    if (prompt.includes('<task-notification>')) return [{ kind: 'notice', id, at: when, text: tag(prompt, 'summary') ?? 'A background task finished.' }]
    const text = typed(prompt)
    return text ? [{ kind: 'user', id, at: when, text }] : []
  }

  if (line.type === 'user' && !line.isMeta) {
    const content = line.message?.content
    if (typeof content === 'string') {
      if (content.includes('<task-notification>')) return [{ kind: 'notice', id, at: when, text: tag(content, 'summary') ?? 'A background task finished.' }]
      const text = typed(content)
      return text ? [{ kind: 'user', id, at: when, text }] : []
    }
    const items: ChatItem[] = []
    const typedParts: string[] = []
    for (const [n, block] of (content ?? []).entries()) {
      if (block.type === 'tool_result' && block.tool_use_id) {
        items.push({ kind: 'result', id: `${id}:${n}`, toolUseId: block.tool_use_id, text: clip(resultText(block.content), RESULT_MAX), isError: block.is_error || undefined })
      } else if (block.type === 'text' && block.text) {
        const text = typed(block.text)
        if (text) typedParts.push(text)
      } else if (block.type === 'image') {
        typedParts.push('[image]')
      }
    }
    if (typedParts.length) items.unshift({ kind: 'user', id, at: when, text: typedParts.join('\n\n') })
    return items
  }

  if (line.type === 'assistant') {
    const content = line.message?.content
    if (typeof content === 'string') return content.trim() ? [{ kind: 'assistant', id, at: when, text: content }] : []
    const items: ChatItem[] = []
    for (const [n, block] of (content ?? []).entries()) {
      if (block.type === 'text' && block.text?.trim()) items.push({ kind: 'assistant', id: `${id}:${n}`, at: when, text: block.text })
      if (block.type === 'tool_use' && block.id && block.name)
        items.push({
          kind: 'tool',
          id: block.id,
          at: when,
          name: block.name,
          summary: summarise(block.name, block.input),
          isBackground: block.input?.run_in_background === true || undefined,
        })
    }
    return items
  }

  return []
}

/** A chat's conversation from byte `from` on; the first read (`from` < 0) takes only the latest part of a long one. */
export function readChat(sessionId: string | undefined, from: number): ChatPage {
  const file = sessionId ? locate(sessionId) : undefined
  if (!file) return { items: [], next: 0, isCut: false, hasTranscript: false }

  const size = statSync(file).size
  const start = from < 0 ? Math.max(0, size - FIRST_READ) : Math.min(from, size)
  if (start >= size) return { items: [], next: size, isCut: false, hasTranscript: true }

  const buffer = Buffer.alloc(size - start)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buffer, 0, buffer.length, start)
  } finally {
    closeSync(fd)
  }

  // Only whole lines: the last one may still be half written, and a cut start lands mid-line.
  const lastBreak = buffer.lastIndexOf(0x0a)
  if (lastBreak < 0) return { items: [], next: start, isCut: false, hasTranscript: true }
  const firstBreak = start > 0 && from < 0 ? buffer.indexOf(0x0a) + 1 : 0
  const text = buffer.subarray(firstBreak, lastBreak).toString('utf8')

  const items: ChatItem[] = []
  let at = start + firstBreak
  for (const raw of text.split('\n')) {
    if (raw.trim()) {
      try {
        items.push(...itemsOf(JSON.parse(raw) as Line, at))
      } catch {
        // A line that is not JSON is skipped; the rest of the chat still shows.
      }
    }
    at += Buffer.byteLength(raw) + 1
  }
  return { items, next: start + lastBreak + 1, isCut: from < 0 && start > 0, hasTranscript: true }
}

/**
 * Follows a chat's conversation and hands each new slice to `send` as soon as Claude writes it. The file
 * watch is the fast path; a slow check covers a watch that misses a write, and a chat whose transcript
 * does not exist yet. Returns the function that stops following.
 */
export function followChat(sessionOf: () => string | undefined, from: number, send: (page: ChatPage) => void): () => void {
  let next = from
  let watched = ''
  let watcher: FSWatcher | undefined
  let soon: ReturnType<typeof setTimeout> | undefined
  let isFirst = true

  const read = () => {
    const page = readChat(sessionOf(), next)
    if (page.hasTranscript) next = page.next
    // The first answer always goes out, so the page knows where it stands; after that, only news.
    if (isFirst || page.items.length > 0) send(page)
    isFirst = false
    const file = page.hasTranscript ? locate(sessionOf()!) : undefined
    if (file && file !== watched) {
      watcher?.close()
      watched = file
      try {
        // Several writes land together; one read after the burst picks them all up.
        watcher = watch(file, () => {
          clearTimeout(soon)
          soon = setTimeout(read, 25)
        })
      } catch {
        watcher = undefined
      }
    }
  }

  read()
  const check = setInterval(read, 2_000)
  return () => {
    clearInterval(check)
    clearTimeout(soon)
    watcher?.close()
  }
}
