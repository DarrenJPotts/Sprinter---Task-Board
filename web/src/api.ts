import type { HealthCheck, LogEntry, NewProject, Prefs, ProjectSummary, Settings, Snapshot } from '../../shared/types'

// The project every call is about; the page sets it once it knows which one is open.
let currentProject = ''
export const setProject = (id: string) => {
  currentProject = id
}
export const projectId = () => currentProject

// The page's own failed calls, for the debug log.
const pageLog: LogEntry[] = []
const listeners = new Set<() => void>()

export const pageErrors = () => [...pageLog]
export function onPageError(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}
export function clearPageErrors() {
  pageLog.length = 0
  listeners.forEach(l => l())
}
function remember(source: string, message: string) {
  pageLog.push({ at: Date.now(), side: 'page', source, message })
  if (pageLog.length > 100) pageLog.shift()
  listeners.forEach(l => l())
}

async function call<T = Snapshot>(path: string, init?: RequestInit): Promise<T> {
  const what = `${init?.method ?? 'GET'} ${path}`
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(currentProject ? { 'x-hq-project': currentProject } : {}), ...init?.headers },
    })
  } catch (caught) {
    const message = `Server not reachable (${caught instanceof Error ? caught.message : String(caught)}): is it running or restarting?`
    remember(what, message)
    throw new Error(message)
  }
  const text = await response.text()
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    // Not JSON: usually an HTML page from an older server or another app on the port.
    const message = `${response.status}, not JSON: ${text.replace(/\s+/g, ' ').slice(0, 80)}`
    remember(what, message)
    throw new Error(`${what} → ${message}`)
  }
  if (!response.ok) {
    const message = (body as { message?: string }).message ?? `${response.status} ${response.statusText}`
    remember(what, message)
    throw new Error(message)
  }

  return body as T
}

export const api = {
  snapshot: () => call('/api/snapshot'),
  refresh: () => call('/api/refresh', { method: 'POST' }),
  savePrefs: (prefs: Prefs) => call('/api/prefs', { method: 'PUT', body: JSON.stringify(prefs) }),
  openTerminal: (key: string, body: { prompt?: string; isShellOnly?: boolean }) =>
    call(`/api/terminals/${key}`, { method: 'POST', body: JSON.stringify(body) }),
  closeTerminal: (key: string) => call(`/api/terminals/${key}`, { method: 'DELETE' }),
  rename: (key: string, name: string) => call(`/api/names/${key}`, { method: 'PUT', body: JSON.stringify({ name }) }),
  forgetSession: (key: string) => call(`/api/sessions/${key}`, { method: 'DELETE' }),
  taskOutput: (file: string) => call<{ text: string; isCut: boolean; size: number }>(`/api/task-output?file=${encodeURIComponent(file)}`),
  openPin: (key: string) => call(`/api/pins/${key}`, { method: 'POST' }),
  sendLine: (key: string, text: string) => call(`/api/terminals/${key}/line`, { method: 'POST', body: JSON.stringify({ text }) }),
  removeWorktree: (key: string) => call(`/api/worktrees/${key}`, { method: 'DELETE' }),
  health: () => call<HealthCheck[]>('/api/health'),
  projects: () => call<{ active: string | null; projects: ProjectSummary[] }>('/api/projects'),
  createProject: (input: NewProject) => call<ProjectSummary>('/api/projects', { method: 'POST', body: JSON.stringify(input) }),
  setActiveProject: (id: string) => call<{ active: string }>('/api/projects/active', { method: 'PUT', body: JSON.stringify({ id }) }),
  serverLog: () => call<LogEntry[]>('/api/log'),
  clearServerLog: () => call<LogEntry[]>('/api/log', { method: 'DELETE' }),
  settings: () => call<Settings>('/api/settings'),
  saveSettings: (settings: Settings) => call<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify(settings) }),
}
