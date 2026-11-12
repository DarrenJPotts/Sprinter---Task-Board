import { existsSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import express from 'express'
import { WebSocketServer } from 'ws'

import type { NewProject, Pin, Prefs, Settings, Snapshot, TokenUsage } from '../shared/types.js'
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
  sendLine,
  worktreeKeys,
} from './terminals.js'
import { hasTranscript, sessionUsage } from './usage.js'

const REFRESH_MS = 5 * 60_000

function usageByKey(p: Project): Record<string, TokenUsage> {
  const out: Record<string, TokenUsage> = {}
  for (const [key, sessionId] of Object.entries(p.saved.sessions)) {
    const usage = sessionUsage(sessionId)
    if (usage) out[key] = usage
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
  scrollback: scrollbackKeys(p),
  resumable: Object.entries(p.saved.sessions)
    .filter(([, id]) => hasTranscript(id))
    .map(([key]) => key),
  worktrees: worktreeKeys(p),
  error: p.error,
  isRefreshing: p.isRefreshing,
  buildId: buildId(),
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
if (existsSync(dist)) {
  app.use(express.static(dist))
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(join(dist, 'index.html')))
}

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

server.listen(appConfig.port, '127.0.0.1', () => {
  console.log(`hq on http://localhost:${appConfig.port}`)
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
