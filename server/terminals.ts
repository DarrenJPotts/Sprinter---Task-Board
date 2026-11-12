import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import type { WriteStream } from 'node:fs'
import { join } from 'node:path'

import pty from '@lydell/node-pty'
import type { IPty } from '@lydell/node-pty'
import type { WebSocket } from 'ws'

import type { TerminalInfo } from '../shared/types.js'
import { plain, terminalState } from './attention.js'
import type { Project } from './projects.js'
import { saveState } from './projects.js'
import { hasTranscript } from './usage.js'

// Enough scrollback that a reopened tab shows where the conversation stands.
const SCROLLBACK_BYTES = 400_000
const TAIL_CHARS = 4000
// Each terminal's output is also written to disk, so a tab still shows its last screen after
// the server restarts. A log past this size is cut back to its newest scrollback on the next open.
const LOG_MAX_BYTES = 2_000_000

type Terminal = {
  project: string
  key: string
  pty: IPty
  cwd: string
  startedAt: number
  isAlive: boolean
  scrollback: string
  clients: Set<WebSocket>
  isClaude: boolean
  lastOutputAt: number
  lastInputAt: number
  /** The latest output as plain text, for spotting a question on screen. */
  tail: string
  log: WriteStream
}

// Keyed `<project>/<key>`: two projects may both have an issue 12.
const terminals = new Map<string, Terminal>()
const slot = (p: Project, key: string) => `${p.config.id}/${key}`

const logDir = (p: Project) => join(p.config.dataDir, 'scrollback')
const logPath = (p: Project, key: string) => join(logDir(p), `${key}.log`)

/** The newest stretch of a terminal's saved output, or '' when it has none. */
export function savedScrollback(p: Project, key: string): string {
  const file = logPath(p, key)
  if (!existsSync(file)) return ''
  return readFileSync(file, 'utf8').slice(-SCROLLBACK_BYTES)
}

/** Terminal keys with output saved on disk. */
export function scrollbackKeys(p: Project): string[] {
  if (!existsSync(logDir(p))) return []
  return readdirSync(logDir(p))
    .filter(name => name.endsWith('.log'))
    .map(name => name.slice(0, -4))
}

function openLog(p: Project, key: string): WriteStream {
  mkdirSync(logDir(p), { recursive: true })
  const file = logPath(p, key)
  if (existsSync(file) && statSync(file).size > LOG_MAX_BYTES) writeFileSync(file, savedScrollback(p, key))
  return createWriteStream(file, { flags: 'a' })
}

export function git(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 120_000 }, (error, stdout, stderr) =>
      error ? reject(new Error(stderr.trim() || error.message)) : resolve(stdout.trim()),
    )
  })
}

export const isTicketKey = (key: string) => /^\d+(-shell)?$/.test(key)

// A ticket's plain shell (`<id>-shell`) shares the ticket's worktree.
const ticketOf = (key: string) => key.replace(/-shell$/, '')
const worktreeDir = (p: Project) => join(p.config.dataDir, 'worktrees')
const worktreePath = (p: Project, key: string) => join(worktreeDir(p), ticketOf(key))

export const worktreeKeys = (p: Project) => (existsSync(worktreeDir(p)) ? readdirSync(worktreeDir(p)) : [])

/** The folder a ticket works in: its own worktree off the base, or the repo itself. */
async function workdir(p: Project, key: string): Promise<string> {
  const { config } = p
  if (!config.repoPath) throw new Error('This project has no repo folder set: add it in Setup')
  // Pins work at the repo root; only tickets (numeric ids) get a worktree of their own.
  if (!isTicketKey(key) || !config.useWorktrees) return config.repoPath

  const path = worktreePath(p, key)
  if (!existsSync(path)) {
    mkdirSync(worktreeDir(p), { recursive: true })
    const [remote, ...branch] = config.baseRef.split('/')
    if (remote && branch.length > 0) await git(['fetch', remote, branch.join('/')], config.repoPath)
    // Detached: the work's own branch is cut by whatever runs in it.
    await git(['worktree', 'add', '--detach', path, config.baseRef], config.repoPath)
  }

  return path
}

/**
 * Quotes a prompt as one argument for the terminal's shell. Windows PowerShell 5.1 strips
 * double quotes when it hands an argument to a program, so they go in escaped as \" there.
 */
function quote(text: string, shell: string) {
  const single = text.replace(/'/g, "''")
  if (/pwsh/i.test(shell)) return `'${single}'`
  if (/powershell/i.test(shell)) return `'${single.replace(/"/g, '\\"')}'`

  return `'${text.replace(/'/g, `'\\''`)}'`
}

function broadcast(terminal: Terminal, message: object) {
  const text = JSON.stringify(message)
  for (const client of terminal.clients) client.send(text)
}

function info(t: Terminal): TerminalInfo {
  const { state, needsYou } = terminalState({ ...t, now: Date.now() })

  return { key: t.key, isAlive: t.isAlive, cwd: t.cwd, startedAt: t.startedAt, state, needsYou }
}

export function listTerminals(p: Project): TerminalInfo[] {
  return [...terminals.values()].filter(t => t.project === p.config.id).map(info)
}

/**
 * Opens a ticket's terminal: a shell in its worktree with Claude Code typed into it.
 * The first open starts a new conversation under a fixed session id with `prompt`;
 * every later open resumes that conversation, so the ticket keeps its context.
 */
export async function openTerminal(
  p: Project,
  key: string,
  options: { prompt?: string; isShellOnly?: boolean; isPromptOnlyIfNew?: boolean },
): Promise<TerminalInfo> {
  const { config, saved } = p
  const running = terminals.get(slot(p, key))
  if (running?.isAlive) return info(running)

  const cwd = await workdir(p, key)
  const shell = pty.spawn(config.shell, [], {
    name: 'xterm-256color',
    cols: 120,
    rows: 32,
    cwd,
    env: { ...process.env, HQ_PROJECT: config.id, HQ_TICKET: ticketOf(key) } as Record<string, string>,
  })
  const terminal: Terminal = {
    project: config.id,
    key,
    pty: shell,
    cwd,
    startedAt: Date.now(),
    isAlive: true,
    scrollback: running?.scrollback ?? savedScrollback(p, key),
    clients: running?.clients ?? new Set(),
    isClaude: !options.isShellOnly,
    lastOutputAt: Date.now(),
    lastInputAt: Date.now(),
    tail: '',
    log: openLog(p, key),
  }
  terminals.set(slot(p, key), terminal)
  if (terminal.scrollback) {
    // A line between the old screen and the new run, so the restart is visible in the history.
    const mark = `\r\n\x1b[2m── reopened ${new Date().toLocaleString()} ──\x1b[0m\r\n`
    terminal.scrollback += mark
    terminal.log.write(mark)
  }

  shell.onData(data => {
    terminal.scrollback = (terminal.scrollback + data).slice(-SCROLLBACK_BYTES)
    terminal.tail = (terminal.tail + plain(data)).slice(-TAIL_CHARS)
    terminal.lastOutputAt = Date.now()
    terminal.log.write(data)
    broadcast(terminal, { type: 'output', data })
  })
  shell.onExit(() => {
    terminal.isAlive = false
    terminal.log.end()
    broadcast(terminal, { type: 'exit' })
  })

  if (!options.isShellOnly) {
    // Resume only once Claude has written the conversation: a start that never got a reply
    // leaves none, and --resume refuses an id it cannot find.
    const known = saved.sessions[key]
    let command: string
    if (known && hasTranscript(known)) {
      // Same conversation, so the ticket keeps its context; a new prompt goes in as the next turn.
      const prompt = options.isPromptOnlyIfNew ? undefined : options.prompt
      command = `${config.claudeCommand} --resume ${known}${prompt ? ` ${quote(prompt, config.shell)}` : ''}`
    } else {
      const id = randomUUID()
      saved.sessions[key] = id
      saveState(p)
      command = `${config.claudeCommand} --session-id ${id}${options.prompt ? ` ${quote(options.prompt, config.shell)}` : ''}`
    }
    shell.write(`${command}\r`)
  }

  return info(terminal)
}

export function attach(p: Project, key: string, socket: WebSocket) {
  const terminal = terminals.get(slot(p, key))
  if (!terminal) {
    // Not running (the server restarted, or it ended): show what it last printed, read-only.
    const saved = savedScrollback(p, key)
    socket.send(JSON.stringify(saved ? { type: 'output', data: saved } : { type: 'missing' }))
    if (saved) socket.send(JSON.stringify({ type: 'exit' }))
    socket.close()

    return
  }
  terminal.clients.add(socket)
  socket.send(JSON.stringify({ type: 'output', data: terminal.scrollback }))
  if (!terminal.isAlive) socket.send(JSON.stringify({ type: 'exit' }))

  socket.on('message', raw => {
    const message = JSON.parse(String(raw)) as { type: string; data?: string; cols?: number; rows?: number }
    if (!terminal.isAlive) return
    if (message.type === 'input' && message.data) {
      terminal.lastInputAt = Date.now()
      terminal.pty.write(message.data)
    }
    if (message.type === 'resize' && message.cols && message.rows) terminal.pty.resize(message.cols, message.rows)
  })
  socket.on('close', () => terminal.clients.delete(socket))
}

/**
 * Types a line into a running Claude terminal, as if you had. Refused when the terminal is
 * back at its shell prompt, where the line would run as a command instead of a message.
 */
export function sendLine(p: Project, key: string, text: string) {
  const terminal = terminals.get(slot(p, key))
  if (!terminal?.isAlive) throw new Error(`${key} is not running`)
  if (!terminal.isClaude) throw new Error(`${key} is a plain shell, not a Claude chat`)
  const lastLine = terminal.tail.trimEnd().split('\n').pop() ?? ''
  // ConPTY paints the prompt without a line break, so match how the line ends, not how it starts.
  if (/PS [A-Z]:\\[^>]*>\s*$/.test(lastLine) || /[$#]\s*$/.test(lastLine)) {
    throw new Error(`Claude is not running in ${key}: it is at the shell prompt`)
  }
  terminal.lastInputAt = Date.now()
  terminal.pty.write(`${text.replace(/[\r\n]+/g, ' ')}\r`)
}

export function closeTerminal(p: Project, key: string) {
  const terminal = terminals.get(slot(p, key))
  if (terminal?.isAlive) terminal.pty.kill()
  terminals.delete(slot(p, key))
}

export function closeAll() {
  for (const terminal of terminals.values()) if (terminal.isAlive) terminal.pty.kill()
  terminals.clear()
}

/**
 * Removes a finished ticket's worktree and stops its terminals. Git refuses a
 * worktree with uncommitted changes, and that refusal is passed back as is.
 */
export async function removeWorktree(p: Project, key: string) {
  const ticket = ticketOf(key)
  closeTerminal(p, ticket)
  closeTerminal(p, `${ticket}-shell`)
  const path = worktreePath(p, ticket)
  if (existsSync(path)) await git(['worktree', 'remove', path], p.config.repoPath)
}
