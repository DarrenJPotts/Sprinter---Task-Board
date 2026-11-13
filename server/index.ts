import { closeSync, existsSync, openSync, readSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import { WebSocketServer } from 'ws'

import { makeRules } from '../shared/workflow.js'
import type { BgTask, ChatTime, Launched, NewProject, NextStep, Pin, Prefs, SessionInfo, Settings, Snapshot, TokenUsage } from '../shared/types.js'
import { followChat, readChat } from './chat.js'
import { addCompletedWork, nodeIo } from './ado.js'
import { checkHealth } from './health.js'
import { clearServerLog, logError, serverLog } from './log.js'
import type { Project } from './projects.js'
import { allProjects, app as appConfig, createProject, getProject, refresh, removeProject, saveConfig, saveState, setActive, summary, workflowOf } from './projects.js'
import {
  attach,
  closeAll,
  closeTerminal,
  isTicketKey,
  listTerminals,
  openTerminal,
  removeWorktree,
  scrollbackKeys,
  sendEscape,
  sendLine,
  worktreeKeys,
} from './terminals.js'
import { hasTranscript, sessionActiveMs, sessionTasks, sessionUsage } from './usage.js'

const REFRESH_MS = 5 * 60_000

function usageByKey(p: Project): Record<string, TokenUsage> {
  const out: Record<string, TokenUsage> = {}
  for (const [key, sessionId] of Object.entries(p.saved.sessions)) {
    const usage = sessionUsage(sessionId)
    if (usage) out[key] = usage
  }

  return out
}

function sessionsOf(p: Project): SessionInfo[] {
  return Object.entries(p.saved.sessions).map(([key, sessionId]) => {
    const usage = sessionUsage(sessionId)
    return {
      key,
      sessionId,
      hasTranscript: hasTranscript(sessionId),
      lastAt: usage?.lastAt,
      tokens: usage ? usage.input + usage.cacheWrite + usage.output : undefined,
    }
  })
}

/** The last batch of ticket sessions a chat started, per project, so open pages add their tabs. */
const launched = new Map<string, Launched>()

/** Every ticket still in play with the command its next step runs, the same one its ▶ Claude button sends. */
function nextSteps(p: Project): NextStep[] {
  const board = p.saved.board
  if (!board) return []
  const rules = makeRules(workflowOf(p), board.columns, p.config.commandTemplate)
  const running = new Set(listTerminals(p).filter(t => t.isAlive).map(t => t.key))
  return board.stories
    .filter(story => !rules.isDone(story))
    .map(story => ({
      id: story.id,
      title: story.title,
      column: story.column,
      stage: rules.stageGroup(story),
      command: rules.nextCommand(story, p.hints[story.id]),
      isRunning: running.has(String(story.id)),
      isOffSprint: story.isOffSprint === true,
    }))
}

/** Each ticket chat's worked time, less what was already logged against that session. */
function timeOf(p: Project): Record<string, ChatTime> {
  const out: Record<string, ChatTime> = {}
  for (const [key, sessionId] of Object.entries(p.saved.sessions)) {
    if (!/^\d+$/.test(key)) continue
    const activeMs = sessionActiveMs(sessionId)
    if (activeMs === 0) continue
    out[key] = { activeMs, unloggedMs: Math.max(0, activeMs - (p.saved.logged[key]?.[sessionId] ?? 0)) }
  }
  return out
}

/** Counts a ticket chat's time so far as logged, whether it went to the board or not. */
function markLogged(p: Project, key: string) {
  const sessionId = p.saved.sessions[key]
  if (!sessionId) return
  p.saved.logged[key] = { ...p.saved.logged[key], [sessionId]: sessionActiveMs(sessionId) }
  saveState(p)
}

function tasksOf(p: Project): Record<string, BgTask[]> {
  const out: Record<string, BgTask[]> = {}
  const terminals = new Map(listTerminals(p).map(t => [t.key, t]))
  for (const [key, sessionId] of Object.entries(p.saved.sessions)) {
    // A background task lives inside the Claude process that started (or resumed) it. The transcript
    // never says when that process dies, so one still "running" from before the chat's current process
    // (or with no process at all) ended with it.
    const terminal = terminals.get(key)
    const since = terminal?.isAlive ? terminal.startedAt : Infinity
    const tasks = sessionTasks(sessionId).map(task =>
      task.status === 'running' && !(Date.parse(task.resumedAt ?? task.startedAt ?? '') >= since) ? { ...task, status: 'ended' } : task,
    )
    if (tasks.length > 0) out[key] = tasks
  }
  return out
}

// The built page's timestamp: a rebuild changes it, so open windows know to reload.
const builtPage = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'index.html')
const buildId = () => (existsSync(builtPage) ? String(statSync(builtPage).mtimeMs) : 'dev')

const snapshot = (p: Project): Snapshot => ({
  board: p.saved.board,
  prefs: p.saved.prefs,
  hints: p.hints,
  terminals: listTerminals(p),
  usage: usageByKey(p),
  names: p.saved.names,
  sessions: sessionsOf(p),
  tasks: tasksOf(p),
  scrollback: scrollbackKeys(p),
  resumable: Object.entries(p.saved.sessions)
    .filter(([, id]) => hasTranscript(id))
    .map(([key]) => key),
  worktrees: worktreeKeys(p),
  error: p.error,
  isRefreshing: p.isRefreshing,
  buildId: buildId(),
  time: timeOf(p),
  launched: launched.get(p.config.id) ?? { seq: 0, keys: [] },
  project: summary(p),
  projects: allProjects().map(summary),
  workflow: workflowOf(p),
  commandTemplate: p.config.commandTemplate,
  syncTasksCommand: p.config.syncTasksCommand,
  focusHoursPerDay: p.config.focusHoursPerDay,
  pins: p.config.pins,
  reviews: p.reviews,
})

const settingsOf = (p: Project): Settings => {
  const c = p.config
  return {
    name: c.name,
    repoPath: c.repoPath,
    baseRef: c.baseRef,
    useWorktrees: c.useWorktrees,
    shell: c.shell,
    claudeCommand: c.claudeCommand,
    tracker: c.tracker,
    ado: c.ado,
    github: c.github,
    workflow: c.workflow,
    commandTemplate: c.commandTemplate,
    syncTasksCommand: c.syncTasksCommand,
    focusHoursPerDay: c.focusHoursPerDay,
    pins: c.pins,
  }
}

const app = express()
app.use(express.json())

// Terminals run commands as you, so only this app's own pages may change anything:
// a browser sends Origin on cross-site requests, and anything not local is refused.
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin
  if (req.method === 'GET' || !origin || /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    next()
    return
  }
  res.status(403).json({ message: `Refused a ${req.method} from ${origin}` })
})

const message = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught))

// --- Projects ---------------------------------------------------------------

app.get('/api/projects', (_req, res) => {
  res.json({ active: appConfig.activeProject, projects: allProjects().map(summary) })
})

app.post('/api/projects', (req, res) => {
  const input = req.body as NewProject
  if (!input?.name?.trim() || (input.tracker !== 'ado' && input.tracker !== 'github')) {
    res.status(400).json({ message: 'A project needs a name and a tracker (ado or github)' })
    return
  }
  const project = createProject(input)
  setActive(project.config.id)
  res.json(summary(project))
})

app.put('/api/projects/active', (req, res) => {
  try {
    setActive(String((req.body as { id?: string }).id))
    res.json({ active: appConfig.activeProject })
  } catch (caught) {
    res.status(404).json({ message: message(caught) })
  }
})

app.delete('/api/projects/:id', (req, res) => {
  try {
    removeProject(req.params.id)
    res.json({ active: appConfig.activeProject, projects: allProjects().map(summary) })
  } catch (caught) {
    res.status(404).json({ message: message(caught) })
  }
})

// --- Everything else is for one project: the page names it in a header ---------

type ProjectRequest = express.Request & { project?: Project }

app.use('/api', (req: ProjectRequest, res, next) => {
  const named = req.get('x-hq-project') ?? (typeof req.query.project === 'string' ? req.query.project : undefined)
  const project = getProject(named)
  if (!project) {
    res.status(404).json({ message: named ? `No project "${named}"` : 'No project yet: create one first' })
    return
  }
  req.project = project
  next()
})

const projectOf = (req: express.Request) => (req as ProjectRequest).project!

app.get('/api/snapshot', (req, res) => {
  const p = projectOf(req)
  // A project nobody has looked at since the server started reads its board on first view.
  if (!p.saved.board && !p.isRefreshing && !p.error) void refresh(p)
  res.json(snapshot(p))
})

app.post('/api/refresh', async (req, res) => {
  const p = projectOf(req)
  await refresh(p)
  res.json(snapshot(p))
})

app.put('/api/prefs', (req, res) => {
  const p = projectOf(req)
  p.saved.prefs = req.body as Prefs
  saveState(p)
  res.json(snapshot(p))
})

app.post('/api/terminals/:key', async (req, res) => {
  const p = projectOf(req)
  const { prompt, isShellOnly } = (req.body ?? {}) as { prompt?: string; isShellOnly?: boolean }
  try {
    await openTerminal(p, req.params.key, { prompt, isShellOnly })
    res.json(snapshot(p))
  } catch (caught) {
    logError(`${p.config.id}: terminal ${req.params.key}`, caught)
    res.status(500).json({ message: message(caught) })
  }
})

// What each ticket would run next, for a chat (Mission Control) to pick sessions to start.
app.get('/api/next', (req, res) => {
  res.json(nextSteps(projectOf(req)))
})

// Starts a Claude session for each ticket, each in its own terminal and worktree, with its next command
// (or the one given). One already running is left alone. Open pages add a tab for every one started.
app.post('/api/sessions/start', async (req, res) => {
  const p = projectOf(req)
  const { items } = (req.body ?? {}) as { items?: { id?: number | string; command?: string }[] }
  if (!Array.isArray(items) || items.length === 0) {
    res.status(400).json({ message: 'Send items: [{ id, command? }]' })
    return
  }
  if (items.length > 12) {
    res.status(400).json({ message: 'At most 12 sessions at a time: each one is a Claude run of its own' })
    return
  }
  const steps = new Map(nextSteps(p).map(step => [String(step.id), step]))
  const started: { id: string; command: string }[] = []
  const skipped: { id: string; why: string }[] = []
  // One at a time: each may cut a git worktree, and git takes a lock on the repo for that.
  for (const item of items) {
    const id = String(item.id ?? '')
    const step = steps.get(id)
    if (!step) {
      skipped.push({ id, why: 'not a ticket on the board, or already done' })
      continue
    }
    if (step.isRunning) {
      skipped.push({ id, why: 'its session is already running' })
      continue
    }
    const command = item.command?.trim() || step.command
    try {
      await openTerminal(p, id, { prompt: command })
      started.push({ id, command })
    } catch (caught) {
      logError(`${p.config.id}: start ${id}`, caught)
      skipped.push({ id, why: message(caught) })
    }
  }
  if (started.length > 0) {
    const last = launched.get(p.config.id)?.seq ?? 0
    launched.set(p.config.id, { seq: last + 1, keys: started.map(s => s.id) })
  }
  res.json({ started, skipped })
})

app.post('/api/terminals/:key/escape', (req, res) => {
  const p = projectOf(req)
  try {
    sendEscape(p, req.params.key)
    res.json(snapshot(p))
  } catch (caught) {
    res.status(409).json({ message: message(caught) })
  }
})

app.post('/api/terminals/:key/line', (req, res) => {
  const p = projectOf(req)
  const { text } = (req.body ?? {}) as { text?: string }
  if (!text?.trim()) {
    res.status(400).json({ message: 'Nothing to send' })
    return
  }
  try {
    sendLine(p, req.params.key, text)
    res.json(snapshot(p))
  } catch (caught) {
    res.status(409).json({ message: message(caught) })
  }
})

app.delete('/api/terminals/:key', (req, res) => {
  const p = projectOf(req)
  closeTerminal(p, req.params.key)
  res.json(snapshot(p))
})

app.delete('/api/worktrees/:key', async (req, res) => {
  const p = projectOf(req)
  try {
    await removeWorktree(p, req.params.key)
    res.json(snapshot(p))
  } catch (caught) {
    logError(`${p.config.id}: worktree ${req.params.key}`, caught)
    res.status(409).json({ message: message(caught) })
  }
})

app.put('/api/names/:key', (req, res) => {
  const p = projectOf(req)
  const name = String((req.body as { name?: string })?.name ?? '').trim().slice(0, 60)
  if (name) p.saved.names[req.params.key] = name
  else delete p.saved.names[req.params.key]
  saveState(p)
  res.json(snapshot(p))
})

/** Forgets a saved session: its terminal stops and its saved screen goes. Claude keeps its transcript. */
// Adds hours to one of the ticket's own tasks on the board (Completed Work), and counts the chat's time as logged.
app.post('/api/time/:key/log', async (req, res) => {
  const p = projectOf(req)
  const key = req.params.key
  const { taskId, hours } = (req.body ?? {}) as { taskId?: number; hours?: number }
  const story = p.saved.board?.stories.find(s => String(s.id) === key)
  const task = story?.tasks.find(t => t.id === Number(taskId))
  if (p.config.tracker !== 'ado' || !p.config.ado) {
    res.status(400).json({ message: 'Logging time needs an Azure DevOps project' })
    return
  }
  if (!task) {
    res.status(400).json({ message: `Task ${taskId} is not one of ${key}'s tasks` })
    return
  }
  if (typeof hours !== 'number' || !(hours > 0) || hours > 24) {
    res.status(400).json({ message: 'Hours must be more than 0 and at most 24' })
    return
  }
  try {
    task.completed = await addCompletedWork(nodeIo(p.config.ado), p.config.ado, task.id, hours)
    markLogged(p, key)
    res.json(snapshot(p))
  } catch (caught) {
    logError(`log time on ${task.id}`, caught)
    res.status(502).json({ message: message(caught) })
  }
})

// Counts the chat's time as logged without writing to the board, for time logged some other way.
app.post('/api/time/:key/clear', (req, res) => {
  const p = projectOf(req)
  markLogged(p, req.params.key)
  res.json(snapshot(p))
})

app.delete('/api/sessions/:key', (req, res) => {
  const p = projectOf(req)
  const key = req.params.key
  closeTerminal(p, key)
  delete p.saved.sessions[key]
  delete p.saved.names[key]
  saveState(p)
  rmSync(join(p.config.dataDir, 'scrollback', `${key}.log`), { force: true })
  res.json(snapshot(p))
})

// A chat's conversation for the chat view, read from Claude's own transcript; ?from= continues a read.
app.get('/api/chat/:key', (req, res) => {
  const p = projectOf(req)
  const from = req.query.from === undefined ? -1 : Number(req.query.from)
  res.json(readChat(p.saved.sessions[req.params.key], Number.isFinite(from) ? from : -1))
})

// The same conversation pushed as Claude writes it (server-sent events), so the chat view never waits on a poll.
app.get('/api/chat/:key/stream', (req, res) => {
  const p = projectOf(req)
  const key = req.params.key
  const from = req.query.from === undefined ? -1 : Number(req.query.from)
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
  res.write(': open\n\n')
  const stop = followChat(
    () => p.saved.sessions[key],
    Number.isFinite(from) ? from : -1,
    page => res.write(`data: ${JSON.stringify(page)}\n\n`),
  )
  // A quiet line now and then keeps the connection from being dropped as idle.
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000)
  req.on('close', () => {
    clearInterval(ping)
    stop()
  })
})

// Only a background task's own output file may be read: one under the temp folder, ending .output.
const TEMP = realpathSync(tmpdir()).toLowerCase()
app.get('/api/task-output', (req, res) => {
  const file = String(req.query.file ?? '')
  let real: string
  try {
    real = realpathSync(file)
  } catch {
    res.status(404).json({ message: 'That output file is gone' })
    return
  }
  if (!real.toLowerCase().startsWith(TEMP) || !real.endsWith('.output')) {
    res.status(403).json({ message: 'Not a background task output file' })
    return
  }
  const size = statSync(real).size
  const length = Math.min(size, 64_000)
  const buffer = Buffer.alloc(length)
  const fd = openSync(real, 'r')
  try {
    readSync(fd, buffer, 0, length, size - length)
  } finally {
    closeSync(fd)
  }
  res.json({ text: buffer.toString('utf8'), isCut: size > length, size })
})

app.get('/api/health', async (req, res) => {
  res.json(await checkHealth(projectOf(req).config))
})

app.get('/api/settings', (req, res) => {
  res.json(settingsOf(projectOf(req)))
})

app.put('/api/settings', (req, res) => {
  const p = projectOf(req)
  const c = p.config
  const next = req.body as Partial<Settings>
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
  c.name = text(next.name)?.trim() || c.name
  c.repoPath = text(next.repoPath) ?? c.repoPath
  c.baseRef = text(next.baseRef) ?? c.baseRef
  c.shell = text(next.shell) ?? c.shell
  c.claudeCommand = text(next.claudeCommand) ?? c.claudeCommand
  c.commandTemplate = text(next.commandTemplate) ?? c.commandTemplate
  c.syncTasksCommand = text(next.syncTasksCommand) ?? c.syncTasksCommand
  if (typeof next.focusHoursPerDay === 'number' && next.focusHoursPerDay > 0) c.focusHoursPerDay = next.focusHoursPerDay
  if (typeof next.useWorktrees === 'boolean') c.useWorktrees = next.useWorktrees
  if (next.workflow === 'auto' || next.workflow === 'aidlc' || next.workflow === 'plain') c.workflow = next.workflow
  if (next.tracker === 'ado' || next.tracker === 'github') c.tracker = next.tracker
  if (next.ado) c.ado = next.ado
  if (next.github) c.github = next.github
  if (Array.isArray(next.pins)) c.pins = cleanPins(next.pins)
  saveConfig(p)
  res.json(settingsOf(p))
})

/** Pins as the settings form sent them, made safe: a usable key, a label, a known mode. */
function cleanPins(pins: Partial<Pin>[]): Pin[] {
  const used = new Set<string>()
  return pins
    .filter(pin => typeof pin.label === 'string' && pin.label.trim())
    .map(pin => {
      const base =
        (typeof pin.key === 'string' && /^[a-z][\w-]*$/i.test(pin.key) && !isTicketKey(pin.key)
          ? pin.key
          : `pin-${pin.label!.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`) || 'pin'
      let key = base
      for (let n = 2; used.has(key); n++) key = `${base}-${n}`
      used.add(key)
      return {
        key,
        label: pin.label!.trim(),
        icon: typeof pin.icon === 'string' && pin.icon.trim() ? pin.icon.trim() : '📌',
        prompt: typeof pin.prompt === 'string' ? pin.prompt : '',
        mode: pin.mode === 'resume' ? 'resume' : 'fresh',
      } satisfies Pin
    })
}

/** Opens a pin: a fresh run restarts its terminal with a new conversation; a kept chat resumes. */
app.post('/api/pins/:key', async (req, res) => {
  const p = projectOf(req)
  const pin = p.config.pins.find(candidate => candidate.key === req.params.key)
  if (!pin) {
    res.status(404).json({ message: `No pin "${req.params.key}"` })
    return
  }
  const prompt = pin.prompt.replaceAll('{sprint}', p.saved.board?.sprint.name ?? '').trim() || undefined
  try {
    if (pin.mode === 'fresh') {
      closeTerminal(p, pin.key)
      delete p.saved.sessions[pin.key]
      await openTerminal(p, pin.key, { prompt })
    } else {
      await openTerminal(p, pin.key, { prompt, isPromptOnlyIfNew: true })
    }
    res.json(snapshot(p))
  } catch (caught) {
    logError(`${p.config.id}: pin ${pin.key}`, caught)
    res.status(500).json({ message: message(caught) })
  }
})

app.get('/api/log', (_req, res) => {
  res.json(serverLog())
})

app.delete('/api/log', (_req, res) => {
  clearServerLog()
  res.json([])
})

// Express answers an unknown route with an HTML page; an API caller always gets JSON it can read.
app.use('/api', (req, res) => {
  const text = `No API route ${req.method} ${req.originalUrl}: the page and the server may be out of step, reload the page`
  logError('api', text)
  res.status(404).json({ message: text })
})

app.use((caught: unknown, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logError(`${req.method} ${req.originalUrl}`, caught)
  res.status(500).json({ message: message(caught) })
})

// Built UI for the app and `npm start`; `npm run dev` serves it through Vite instead.
const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')
app.use(express.static(dist))
app.get(/^\/(?!api|ws).*/, (_req, res) => {
  const page = join(dist, 'index.html')
  if (existsSync(page)) {
    res.sendFile(page)
    return
  }
  // Mid-rebuild the page is briefly gone: a window that reloads now waits and tries again, not a 404.
  res.type('html').send('<!doctype html><meta http-equiv="refresh" content="2"><title>Sprinter</title><p style="font-family:sans-serif">Sprinter is rebuilding…</p>')
})

const server = createServer(app)
const sockets = new WebSocketServer({ noServer: true })

server.on('upgrade', (req, socket, head) => {
  const match = /^\/ws\/terminals\/([\w-]+)\/([\w-]+)$/.exec(req.url ?? '')
  // A terminal runs commands as you: only pages served from this machine may attach.
  const origin = req.headers.origin ?? ''
  const isLocal = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) || origin === 'file://'
  const project = match ? getProject(match[1]) : null
  if (!match || !isLocal || !project) {
    socket.destroy()
    return
  }
  sockets.handleUpgrade(req, socket, head, ws => attach(project, match[2]!, ws))
})

// SPRINTER_PORT runs a second copy beside the usual one, e.g. to try a packaged build.
const port = Number(process.env.SPRINTER_PORT) || appConfig.port
// Every terminal inherits this, so a chat running in one can reach the API (the sprinter skill uses it).
process.env.HQ_URL = `http://127.0.0.1:${port}`
server.listen(port, '127.0.0.1', () => {
  console.log(`hq on http://localhost:${port}`)
  const active = getProject(null)
  if (active) void refresh(active)
  // Every project anyone has opened since start keeps its board fresh.
  setInterval(() => {
    for (const p of allProjects()) if (p.saved.board || p.error) void refresh(p)
  }, REFRESH_MS)
})

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    closeAll()
    process.exit(0)
  })
}
