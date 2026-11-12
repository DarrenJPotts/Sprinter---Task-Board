import type { PlanHint, Prefs, Story, Task, When } from './types.js'

/** ADO board columns in flow order; a story's group on the board view. */
export const COLUMNS = [
  'New',
  'Requirements',
  'Ready for Spec',
  'Spec In Progress',
  'Spec Review',
  'Ready for Implementation',
  'Implementation In Progress',
  'Implementation Review',
  'Ready for QA',
  'Done',
] as const

export const WHENS: readonly { value: When; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'This week' },
  { value: 'next', label: 'Next week' },
  { value: 'later', label: 'Parked' },
]

// Notion's tag palette: a pastel fill with its own dark ink, so a pill reads the
// same whether the app is light or dark.
export const PILL = {
  gray: { bg: '#E3E2E0', fg: '#32302C' },
  brown: { bg: '#EEE0DA', fg: '#442A1E' },
  orange: { bg: '#FADEC9', fg: '#49290E' },
  yellow: { bg: '#FDECC8', fg: '#402C1B' },
  green: { bg: '#DBEDDB', fg: '#1C3829' },
  blue: { bg: '#D3E5EF', fg: '#183347' },
  purple: { bg: '#E8DEEE', fg: '#412454' },
  pink: { bg: '#F5E0E9', fg: '#4C2337' },
  red: { bg: '#FFE2DD', fg: '#5D1715' },
} as const

export type PillColor = keyof typeof PILL

export const COLUMN_COLOR: Record<string, PillColor> = {
  New: 'gray',
  Requirements: 'gray',
  'Ready for Spec': 'brown',
  'Spec In Progress': 'orange',
  'Spec Review': 'yellow',
  'Ready for Implementation': 'blue',
  'Implementation In Progress': 'purple',
  'Implementation Review': 'pink',
  'Ready for QA': 'green',
  Done: 'gray',
}

export const TIER_COLOR: Record<string, PillColor> = { T3: 'red', T2: 'yellow', T1: 'green' }


const STAGES = ['Spec', 'Spec Review', 'Implementation', 'Dev Testing', 'Implementation Review']

// Gate time, not the developer's: reviews are automated, testers own QA/UAT.
const NOT_MINE = new Set(['Spec Review', 'Implementation Review', 'QA Testing', 'UAT Testing'])

const STAGE_OF_COLUMN: Record<string, number> = {
  'Spec In Progress': 0,
  'Spec Review': 1,
  'Ready for Implementation': 2,
  'Implementation In Progress': 2,
  'Implementation Review': 4,
  'Ready for QA': 5,
  Done: 5,
}

export const isClosed = (state: string) => /^(done|closed|removed|resolved)$/i.test(state)

const isNew = (state: string) => /^(new|to do|proposed)$/i.test(state)

export const columnIndex = (column: string) => {
  const at = COLUMNS.indexOf(column as (typeof COLUMNS)[number])

  return at === -1 ? COLUMNS.length : at
}

export function stageTask(story: Story, stage: string): Task | undefined {
  return story.tasks.find(task => task.title.trim().toLowerCase() === stage.toLowerCase())
}

/** Hours still owed on the developer's own open stage tasks. */
export function remainingHours(story: Story): number {
  return story.tasks
    .filter(task => !isClosed(task.state) && !NOT_MINE.has(task.title.trim()))
    .reduce((sum, task) => sum + task.remaining, 0)
}

/** Board drift for one story, each line with the move it implies. */
export function drift(story: Story): string[] {
  const out: string[] = []
  const current = STAGE_OF_COLUMN[story.column]

  if (current !== undefined) {
    STAGES.forEach((stage, at) => {
      const task = stageTask(story, stage)
      if (!task) return
      if (at < current && !isClosed(task.state)) {
        out.push(`${stage} task still ${task.state}`)
      }
      if (at === current && isNew(task.state) && stage !== 'Dev Testing') {
        out.push(`${stage} task not started`)
      }
    })
  }

  const specPr = story.prs.find(pr => pr.branch.startsWith('spec/') && !pr.isDraft && !pr.isCompleted)
  if (specPr && story.column !== 'Spec Review') {
    out.push(`Spec PR ${specPr.id} is up; board says ${story.column}`)
  }

  return out
}

export const hasTaskDrift = (story: Story) => drift(story).some(line => line.includes('task'))

/** The stage command a card's session runs next. */
export function nextCommand(story: Story, hint?: PlanHint): string {
  if (hint?.cmd) return hint.cmd

  const id = story.id
  const hasComments = story.prs.some(pr => !pr.isCompleted && (pr.vote < 0 || pr.openThreads > 0))
  switch (story.column) {
    case 'New':
    case 'Requirements':
      return `/product-groom ${id}`
    case 'Ready for Spec':
    case 'Spec In Progress':
      return `/dev-spec ${id}`
    case 'Spec Review':
      return hasComments ? `/dev-spec-revise ${id}` : `/dev-spec-finish ${id}`
    case 'Ready for Implementation':
    case 'Implementation In Progress':
      return `/dev-implement ${id}`
    case 'Implementation Review':
      return hasComments ? `/dev-implement-revise ${id}` : `/dev-implement-finish ${id}`
    case 'Ready for QA':
      return `/dev-ship-feature ${id}`
    case 'Done':
      return `/dev-finish ${id}`
    default:
      return `/dev-ticket ${id}`
  }
}

/** Where a story sits on the plan view: the saved move, the planner's, then the lane rule. */
export function whenOf(story: Story, prefs: Prefs, hint?: PlanHint): When {
  const saved = prefs.when[String(story.id)]
  if (saved) return saved
  if (hint?.when) return hint.when
  if (story.isOffSprint) return 'later'

  switch (story.column) {
    case 'Ready for QA':
    case 'Implementation Review':
    case 'Spec Review':
      return 'today'
    case 'Ready for Implementation':
    case 'Implementation In Progress':
    case 'Spec In Progress':
    case 'Ready for Spec':
      return 'week'
    default:
      return 'later'
  }
}

const tierRank = (tier?: string) => (tier === 'T3' ? 0 : tier === 'T2' ? 1 : 2)

/** Starred first in starred order, then finishing before starting, T3 first, then rank. */
export function order(stories: readonly Story[], prefs: Prefs, hints: Record<string, PlanHint>) {
  const star = (story: Story) => {
    const at = prefs.pinned.indexOf(story.id)

    return at === -1 ? Number.MAX_SAFE_INTEGER : at
  }

  return [...stories].sort(
    (a, b) =>
      star(a) - star(b) ||
      (hints[a.id]?.step ?? 99) - (hints[b.id]?.step ?? 99) ||
      columnIndex(b.column) - columnIndex(a.column) ||
      tierRank(a.tier) - tierRank(b.tier) ||
      a.priority - b.priority ||
      a.rank - b.rank,
  )
}

/** Mon–Fri days from `today` to `finish` inclusive, both `YYYY-MM-DD`. */
export function workingDaysLeft(today: string, finish: string): number {
  const end = Date.parse(`${finish.slice(0, 10)}T00:00:00Z`)
  let day = Date.parse(`${today.slice(0, 10)}T00:00:00Z`)
  let count = 0
  while (day <= end) {
    const weekday = new Date(day).getUTCDay()
    if (weekday !== 0 && weekday !== 6) count += 1
    day += 86_400_000
  }

  return count
}

/** `team-sprint-4` from `Team_Sprint 4`: a sprint name as a file-name slug. */
export const sprintSlug = (name: string) => name.toLowerCase().replace(/[_\s]+/g, '-')

/** Whether a session's title or branch names the work item as a whole number. */
export function namesItem(text: string, id: number): boolean {
  return new RegExp(`(^|\\D)${id}(\\D|$)`).test(text)
}

export const shortDate = (iso: string) => {
  const date = new Date(iso)
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][
    date.getUTCMonth()
  ]

  return `${date.getUTCDate()} ${month}`
}

export const clock = (ms: number) => {
  const date = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')

  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Review threads waiting on you across the story's open PRs. */
export const reviewThreads = (story: Story) =>
  story.prs.filter(pr => !pr.isCompleted).reduce((sum, pr) => sum + pr.openThreads, 0)

/** Where a ticket is in the delivery process, for grouping its terminals. */
export const STAGE_GROUPS = ['Spec', 'Spec Review', 'Impl', 'Dev Test', 'Impl Review', 'Ship Ready', 'Done', 'Not ready'] as const
export type StageGroup = (typeof STAGE_GROUPS)[number]

export const STAGE_GROUP_COLOR: Record<StageGroup, PillColor> = {
  Spec: 'orange',
  'Spec Review': 'yellow',
  Impl: 'blue',
  'Dev Test': 'purple',
  'Impl Review': 'pink',
  'Ship Ready': 'green',
  Done: 'gray',
  'Not ready': 'gray',
}

const isActive = (state: string) => /^(active|in progress|doing|committed)$/i.test(state)

export function stageGroup(story: Story): StageGroup {
  switch (story.column) {
    case 'Ready for Spec':
    case 'Spec In Progress':
      return 'Spec'
    case 'Spec Review':
      return 'Spec Review'
    case 'Ready for Implementation':
    case 'Implementation In Progress': {
      // Dev Testing has no board column of its own: its task being under way is the signal.
      const devTest = stageTask(story, 'Dev Testing')
      return devTest && isActive(devTest.state) ? 'Dev Test' : 'Impl'
    }
    case 'Implementation Review':
      return 'Impl Review'
    case 'Ready for QA':
      return 'Ship Ready'
    case 'Done':
      return 'Done'
    default:
      return 'Not ready'
  }
}
