import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { Pin, TrackerKind, WorkflowChoice } from '../shared/types.js'

export type AdoConfig = {
  org: string
  project: string
  repo: string
  tenant: string
  areaPath: string
  /** The team node under the project's iterations that holds the sprints. */
  team: string
  /** The ADO team whose board gives the columns, when it is named differently from `team`. */
  boardTeam?: string
}

export type GitHubConfig = {
  /** owner/name of the repository whose issues and PRs the board shows. */
  repo: string
  /** A GitHub Project (v2) number on the repo's owner: its Status field gives the columns. Optional. */
  projectNumber?: number
}

/** One project: a repo, its tracker, how its cards turn into Claude commands, and its pins. */
export type ProjectConfig = {
  id: string
  name: string
  /** The repo the ticket terminals work in. */
  repoPath: string
  /** What a ticket's worktree is cut from. */
  baseRef: string
  /** Give each ticket its own git worktree, so two tickets never share a checkout. */
  useWorktrees: boolean
  /** The shell a terminal runs; `claude` is typed into it. */
  shell: string
  claudeCommand: string
  tracker: TrackerKind
  ado?: AdoConfig
  github?: GitHubConfig
  /** `auto` picks AI-DLC when the repo has an ai-dlc.json, else Plain. */
  workflow: WorkflowChoice
  /** Plain workflow: what a card's ▶ Claude sends. `{id}` and `{title}` are filled in. */
  commandTemplate: string
  /** A command that brings a ticket's stage tasks in line with its column; empty hides the button. */
  syncTasksCommand: string
  /** Hours a working day holds, for the sprint load bar. */
  focusHoursPerDay: number
  pins: Pin[]
  /** Where this project's state, saved screens and worktrees live. */
  dataDir: string
}

export type AppConfig = { port: number; activeProject: string | null }

export const HQ_DIR = join(homedir(), '.sprinter')
// The app was called HQ before Sprinter: its settings folder moves across once.
const OLD_HQ_DIR = join(homedir(), '.hq')
if (!existsSync(HQ_DIR) && existsSync(OLD_HQ_DIR)) renameSync(OLD_HQ_DIR, HQ_DIR)
const APP_FILE = join(HQ_DIR, 'app.json')
const PROJECTS_DIR = join(HQ_DIR, 'projects')
// Where the single-project version kept everything; its project is migrated in place.
const LEGACY_DIR = join(homedir(), '.lcv-hq')

const projectFile = (id: string) => join(PROJECTS_DIR, id, 'project.json')

export const defaultShell = () => (process.platform === 'win32' ? 'powershell.exe' : process.env.SHELL || 'bash')

export function projectDefaults(id: string, name: string): ProjectConfig {
  return {
    id,
    name,
    repoPath: '',
    baseRef: 'origin/main',
    useWorktrees: true,
    shell: defaultShell(),
    claudeCommand: 'claude',
    tracker: 'github',
    workflow: 'auto',
    commandTemplate: 'Work on #{id}: {title}',
    syncTasksCommand: '',
    focusHoursPerDay: 6,
    pins: [],
    dataDir: join(PROJECTS_DIR, id),
  }
}

/** A filesystem-safe id from a project name, not clashing with one already used. */
export function newProjectId(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'project'
  let id = base
  for (let n = 2; existsSync(join(PROJECTS_DIR, id)); n++) id = `${base}-${n}`
  return id
}

export function saveProjectConfig(config: ProjectConfig) {
  mkdirSync(join(PROJECTS_DIR, config.id), { recursive: true })
  mkdirSync(config.dataDir, { recursive: true })
  writeFileSync(projectFile(config.id), JSON.stringify(config, null, 2))
}

export function saveAppConfig(app: AppConfig) {
  mkdirSync(HQ_DIR, { recursive: true })
  writeFileSync(APP_FILE, JSON.stringify(app, null, 2))
}

/** The single-project setup (~/.lcv-hq) becomes the first project, its data left where it is. */
function migrateLegacy(): AppConfig | null {
  const legacyFile = join(LEGACY_DIR, 'config.json')
  if (!existsSync(legacyFile)) return null
  const old = JSON.parse(readFileSync(legacyFile, 'utf8')) as Partial<ProjectConfig> & { port?: number; ado?: AdoConfig }
  const config: ProjectConfig = {
    ...projectDefaults('lcv', 'LCV'),
    repoPath: old.repoPath ?? '',
    baseRef: old.baseRef ?? 'origin/master',
    useWorktrees: old.useWorktrees ?? true,
    shell: old.shell ?? defaultShell(),
    claudeCommand: old.claudeCommand ?? 'claude',
    tracker: 'ado',
    ado: old.ado,
    workflow: 'auto',
    syncTasksCommand: '/lcv-stage-tasks {id}',
    pins: old.pins ?? [],
    dataDir: LEGACY_DIR,
  }
  saveProjectConfig(config)
  const app = { port: old.port ?? 7430, activeProject: 'lcv' }
  saveAppConfig(app)

  return app
}

export function loadAppConfig(): AppConfig {
  if (existsSync(APP_FILE)) return { port: 7430, activeProject: null, ...(JSON.parse(readFileSync(APP_FILE, 'utf8')) as Partial<AppConfig>) }
  const migrated = migrateLegacy()
  if (migrated) return migrated
  const fresh = { port: 7430, activeProject: null }
  saveAppConfig(fresh)

  return fresh
}

export function loadProjectConfigs(): ProjectConfig[] {
  if (!existsSync(PROJECTS_DIR)) return []
  return readdirSync(PROJECTS_DIR)
    .filter(id => existsSync(projectFile(id)))
    .map(id => {
      const config = { ...projectDefaults(id, id), ...(JSON.parse(readFileSync(projectFile(id), 'utf8')) as Partial<ProjectConfig>), id }
      // A project made under the HQ name kept its data in ~/.hq, which has moved.
      if (config.dataDir.startsWith(OLD_HQ_DIR)) config.dataDir = HQ_DIR + config.dataDir.slice(OLD_HQ_DIR.length)
      return config
    })
}
