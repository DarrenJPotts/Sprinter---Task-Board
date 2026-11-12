import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'

import { sprintSlug } from '../shared/model.js'
import type { NewProject, PlanHint, ProjectSummary, ReviewPr, When, Workflow } from '../shared/types.js'
import { nodeIo, readBoard, reviewQueue } from './ado.js'
import type { AppConfig, ProjectConfig } from './config.js'
import { HQ_DIR, loadAppConfig, loadProjectConfigs, newProjectId, projectDefaults, saveAppConfig, saveProjectConfig } from './config.js'
import { gitHubReviewQueue, readGitHubBoard } from './github.js'
import { logError } from './log.js'
import type { Saved } from './store.js'
import { loadSaved, save } from './store.js'

/** A project as the server holds it: its settings, its saved state, and what the last refresh found. */
export type Project = {
  config: ProjectConfig
  saved: Saved
  hints: Record<string, PlanHint>
  reviews: ReviewPr[]
  error?: string
  isRefreshing: boolean
}

export const app: AppConfig = loadAppConfig()
const projects = new Map<string, Project>()
for (const config of loadProjectConfigs()) {
  projects.set(config.id, { config, saved: loadSaved(config.dataDir), hints: {}, reviews: [], isRefreshing: false })
}
if (!app.activeProject || !projects.has(app.activeProject)) {
  app.activeProject = projects.keys().next().value ?? null
  saveAppConfig(app)
}

export const allProjects = () => [...projects.values()]
export const summary = (p: Project): ProjectSummary => ({ id: p.config.id, name: p.config.name, tracker: p.config.tracker })
export const getProject = (id: string | undefined | null) => projects.get(id ?? app.activeProject ?? '') ?? null

export function setActive(id: string) {
  if (!projects.has(id)) throw new Error(`No project "${id}"`)
  app.activeProject = id
  saveAppConfig(app)
}

/** AI-DLC when the project says so, or when it says auto and the repo carries an ai-dlc.json. */
export function workflowOf(p: Project): Workflow {
  if (p.config.workflow !== 'auto') return p.config.workflow
  return p.config.repoPath && existsSync(join(p.config.repoPath, 'ai-dlc.json')) ? 'aidlc' : 'plain'
}

export const saveState = (p: Project) => save(p.config.dataDir, p.saved)
export const saveConfig = (p: Project) => saveProjectConfig(p.config)

const PLAN_WHEN: Record<string, When> = { today: 'today', week1: 'week', week2: 'next', later: 'later' }

/**
 * Optional ordering hints: a sprint planner may write `.aidlc/notes/sprint-plan-<sprint>.json`
 * (items with id, cmd, why, when, step). Without that file the board orders cards by its own rules.
 */
function loadHints(p: Project, sprintName: string) {
  const file = join(p.config.repoPath, '.aidlc', 'notes', `sprint-plan-${sprintSlug(sprintName)}.json`)
  const out: Record<string, PlanHint> = {}
  if (existsSync(file)) {
    const plan = JSON.parse(readFileSync(file, 'utf8')) as {
      items?: { id?: number | string; cmd?: string; why?: string; when?: string; step?: number }[]
    }
    for (const item of [...(plan.items ?? [])].sort((a, b) => (a.step ?? 99) - (b.step ?? 99))) {
      const id = String(item.id ?? '')
      if (id && !out[id]) out[id] = { cmd: item.cmd, why: item.why, when: PLAN_WHEN[item.when ?? ''], step: item.step }
    }
  }
  p.hints = out
}

/** Reads the project's board and review queue from its tracker. */
export async function refresh(p: Project) {
  if (p.isRefreshing) return
  p.isRefreshing = true
  try {
    const { config } = p
    if (config.tracker === 'ado') {
      if (!config.ado) throw new Error('This project has no Azure DevOps settings')
      p.saved.board = await readBoard(nodeIo(config.ado), config.ado, Date.now())
      p.reviews = await reviewQueue(nodeIo(config.ado), config.ado).catch(caught => {
        logError(`${config.id}: review queue`, caught)
        return p.reviews
      })
    } else {
      if (!config.github?.repo) throw new Error('This project has no GitHub repository set')
      p.saved.board = await readGitHubBoard(config.github, Date.now())
      p.reviews = await gitHubReviewQueue(config.github).catch(caught => {
        logError(`${config.id}: review queue`, caught)
        return p.reviews
      })
    }
    saveState(p)
    if (workflowOf(p) === 'aidlc') loadHints(p, p.saved.board.sprint.name)
    else p.hints = {}
    p.error = undefined
  } catch (caught) {
    p.error = caught instanceof Error ? caught.message : String(caught)
    logError(`${p.config.id}: refresh`, caught)
  } finally {
    p.isRefreshing = false
  }
}

/** The starting pins a new project gets: the AI-DLC planner where it applies, else a generic pair. */
function starterPins(workflow: Workflow) {
  return workflow === 'aidlc'
    ? [
        { key: 'status', label: 'Status', icon: '🧭', prompt: '/aidlc-status', mode: 'fresh' as const },
        { key: 'reviewer', label: 'Reviewer', icon: '🔎', prompt: 'You review the open PRs in this repo that are not mine, with /dev-pr-review. Draft each review and wait for me to say "post <PR>"; never approve or merge.', mode: 'resume' as const },
      ]
    : [
        { key: 'open-work', label: 'My work', icon: '📋', prompt: 'List my open issues and PRs in this repo, with what each needs next. Read-only.', mode: 'fresh' as const },
        { key: 'reviewer', label: 'Reviewer', icon: '🔎', prompt: 'You review the open PRs in this repo that are not mine. Draft a review of each and wait for me to say "post <PR>"; never approve or merge.', mode: 'resume' as const },
      ]
}

export function createProject(input: NewProject): Project {
  const id = newProjectId(input.name)
  const config: ProjectConfig = {
    ...projectDefaults(id, input.name.trim() || id),
    repoPath: input.repoPath.trim(),
    baseRef: input.baseRef.trim() || 'origin/main',
    tracker: input.tracker,
    workflow: input.workflow,
    ado: input.tracker === 'ado' ? input.ado : undefined,
    github: input.tracker === 'github' ? input.github : undefined,
  }
  const project: Project = { config, saved: loadSaved(config.dataDir), hints: {}, reviews: [], isRefreshing: false }
  config.pins = starterPins(workflowOf(project))
  saveProjectConfig(config)
  projects.set(id, project)
  void refresh(project)

  return project
}

/** Forgets a project. Its settings folder goes; data it keeps outside ~/.sprinter (the migrated single-project setup) stays. */
export function removeProject(id: string) {
  const project = projects.get(id)
  if (!project) throw new Error(`No project "${id}"`)
  projects.delete(id)
  rmSync(join(HQ_DIR, 'projects', id), { recursive: true, force: true })
  if (app.activeProject === id) {
    app.activeProject = projects.keys().next().value ?? null
    saveAppConfig(app)
  }
}
