export type Task = {
  id: number
  title: string
  state: string
  remaining: number
  completed: number
}

export type Pr = {
  id: number
  title: string
  branch: string
  isDraft: boolean
  url: string
  /** Lowest reviewer vote: -10 rejected, -5 waiting, 0 none, 5/10 approved. */
  vote: number
  isCompleted: boolean
  /** Active review threads with a comment from someone other than the author. */
  openThreads: number
}

export type Story = {
  id: number
  type: string
  title: string
  column: string
  state: string
  tags: string[]
  tier?: string
  points?: number
  priority: number
  rank: number
  isOffSprint: boolean
  iteration: string
  url: string
  tasks: Task[]
  prs: Pr[]
}

/** The current sprint or iteration; `start` and `finish` are empty when the tracker has none. */
export type Sprint = { name: string; path: string; start: string; finish: string }

/** `columns` are the tracker board's own columns, in its order. */
export type Board = { sprint: Sprint; stories: Story[]; columns: string[]; fetchedAt: number }

export type TrackerKind = 'ado' | 'github'
export type Workflow = 'aidlc' | 'plain'
export type WorkflowChoice = 'auto' | Workflow

export type ProjectSummary = { id: string; name: string; tracker: TrackerKind }

/** What the New project form sends. */
export type NewProject = {
  name: string
  repoPath: string
  baseRef: string
  tracker: TrackerKind
  workflow: WorkflowChoice
  ado?: { org: string; project: string; repo: string; tenant: string; areaPath: string; team: string }
  github?: { repo: string; projectNumber?: number }
}

export type When = 'today' | 'week' | 'next' | 'later'

export type Prefs = {
  /** Saved moves on the Plan view, by work-item id. */
  when: Record<string, When>
  /** Starred ids, in the order starred. */
  pinned: number[]
}

/** What the planner's own JSON says about a story, when one exists for the sprint. */
export type PlanHint = { cmd?: string; why?: string; when?: When; step?: number }

export type TerminalState = 'working' | 'asking' | 'idle' | 'exited'

export type TerminalInfo = {
  /** A work-item id, `<id>-shell` for its plain shell, or `planner` for the repo-root terminal. */
  key: string
  isAlive: boolean
  cwd: string
  startedAt: number
  state: TerminalState
  /** Claude is asking something, or has finished its turn since you last typed. */
  needsYou: boolean
}

/** Tokens a ticket's Claude session has used, from its transcript. */
export type TokenUsage = {
  /** Uncached input. */
  input: number
  /** Input written to the prompt cache (billed above plain input). */
  cacheWrite: number
  /** Input read back from the cache (billed at a tenth of plain input). */
  cacheRead: number
  output: number
  /** API requests, one per model step. */
  turns: number
  /** input + cacheWrite + output since midnight. */
  today: number
  lastAt?: string
}

/** One failure for the debug log: from the server, or from the page's own calls. */
export type LogEntry = { at: number; side: 'server' | 'page'; source: string; message: string }

export type HealthCheck = { name: string; isOk: boolean; detail: string; fix?: string }

/**
 * A pinned chat: a named Claude terminal at the repo root, opened from the pin bar.
 * `resume` keeps one conversation and sends the prompt only the first time;
 * `fresh` starts a new conversation with the prompt on every press.
 */
export type Pin = {
  key: string
  label: string
  icon: string
  /** `{sprint}` becomes the current sprint's name. */
  prompt: string
  mode: 'resume' | 'fresh'
}

/** A PR someone else opened, waiting for review. */
export type ReviewPr = {
  id: number
  title: string
  author: string
  createdAt: string
  isDraft: boolean
  /** Reviewer votes of 10 (approved) or 5 (approved with suggestions). */
  approvals: number
  /** Votes asking for changes: -5 waiting on author, -10 rejected. */
  changesAsked: number
  url: string
}

export type Settings = {
  name: string
  repoPath: string
  baseRef: string
  useWorktrees: boolean
  shell: string
  claudeCommand: string
  tracker: TrackerKind
  ado?: NewProject['ado']
  github?: NewProject['github']
  workflow: WorkflowChoice
  commandTemplate: string
  syncTasksCommand: string
  focusHoursPerDay: number
  pins: Pin[]
}

export type Snapshot = {
  board: Board | null
  prefs: Prefs
  hints: Record<string, PlanHint>
  terminals: TerminalInfo[]
  /** Token use per terminal key that has a Claude session. */
  usage: Record<string, TokenUsage>
  /** Terminal keys whose last screen is saved, shown when they are not running. */
  scrollback: string[]
  /** Terminal keys with a Claude conversation that Resume can reopen. */
  resumable: string[]
  /** Ticket ids that have a worktree on disk. */
  worktrees: string[]
  error?: string
  isRefreshing: boolean
  /** The project this snapshot is for, and every project there is. */
  project: ProjectSummary
  projects: ProjectSummary[]
  workflow: Workflow
  commandTemplate: string
  /** Run from a ticket whose stage tasks lag its column; empty hides the button. `{id}` is filled in. */
  syncTasksCommand: string
  /** Hours a working day holds, for the sprint load bar. */
  focusHoursPerDay: number
  pins: Pin[]
  /** Other people's active PRs, for the reviewer. */
  reviews: ReviewPr[]
  /** Changes with every UI build; an open page that sees a new one reloads itself. */
  buildId: string
}
