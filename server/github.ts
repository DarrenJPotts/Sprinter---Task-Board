import { execFile } from 'node:child_process'

import type { Board, Pr, ReviewPr, Sprint, Story } from '../shared/types.js'
import type { GitHubConfig } from './config.js'

// GitHub through the signed-in `gh` CLI's token: GraphQL for projects, PRs and review threads.
const API = 'https://api.github.com/graphql'
const TOKEN_LIFE_MS = 30 * 60_000
let token: { value: string; at: number } | null = null

function ghToken(): Promise<string> {
  // A token in the environment wins; otherwise the signed-in gh CLI lends its own.
  const fromEnv = process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  if (fromEnv) return Promise.resolve(fromEnv)
  return new Promise((resolve, reject) => {
    execFile('gh', ['auth', 'token'], { shell: process.platform === 'win32', timeout: 30_000 }, (error, stdout, stderr) => {
      const value = stdout.trim()
      if (error && /not recognized|not found|ENOENT/i.test(`${stderr} ${error.message}`)) {
        reject(new Error('The GitHub CLI (gh) is not installed: winget install GitHub.cli, then gh auth login (or set GH_TOKEN)'))
      } else if (error || !value) {
        reject(new Error(stderr.trim().split('\n').pop() || 'gh is not signed in: run gh auth login'))
      }
      else resolve(value)
    })
  })
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!token || Date.now() - token.at > TOKEN_LIFE_MS) token = { value: await ghToken(), at: Date.now() }
    const response = await fetch(API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token.value}`, 'Content-Type': 'application/json', 'User-Agent': 'sprinter' },
      body: JSON.stringify({ query, variables }),
    })
    if (response.status === 401 && attempt === 0) {
      token = null
      continue
    }
    const body = (await response.json()) as { data?: T; errors?: { message: string }[] }
    if (!response.ok || body.errors?.length) {
      throw new Error(`GitHub ${response.status}: ${body.errors?.map(e => e.message).join('; ') ?? response.statusText}`)
    }
    return body.data as T
  }

  throw new Error('GitHub refused the token twice: run gh auth login')
}

const split = (repo: string) => {
  const [owner, name] = repo.split('/')
  if (!owner || !name) throw new Error(`GitHub repo "${repo}" should be owner/name`)
  return { owner, name }
}

let viewer: string | null = null
async function me(): Promise<string> {
  if (!viewer) viewer = (await graphql<{ viewer: { login: string } }>('query { viewer { login } }', {})).viewer.login
  return viewer
}

type FieldValue = {
  name?: string
  title?: string
  startDate?: string
  duration?: number
  number?: number
  field?: { name?: string }
}

type Issue = {
  __typename?: string
  number: number
  title: string
  url: string
  state: string
  repository?: { nameWithOwner: string }
  assignees: { nodes: { login: string }[] }
  labels: { nodes: { name: string }[] }
}

type ProjectItem = { fieldValues: { nodes: FieldValue[] }; content: Issue | null }

type ProjectData = {
  repositoryOwner: {
    projectV2: {
      title: string
      fields: { nodes: { name?: string; options?: { name: string }[]; configuration?: { iterations: { title: string; startDate: string; duration: number }[] } }[] }
      items: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: ProjectItem[] }
    } | null
  } | null
}

const PROJECT_QUERY = `query($owner: String!, $number: Int!, $after: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        title
        fields(first: 50) {
          nodes {
            ... on ProjectV2SingleSelectField { name options { name } }
            ... on ProjectV2IterationField { name configuration { iterations { title startDate duration } } }
          }
        }
        items(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            fieldValues(first: 30) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue { name field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldIterationValue { title startDate duration field { ... on ProjectV2FieldCommon { name } } }
                ... on ProjectV2ItemFieldNumberValue { number field { ... on ProjectV2FieldCommon { name } } }
              }
            }
            content {
              __typename
              ... on Issue {
                number title url state repository { nameWithOwner }
                assignees(first: 10) { nodes { login } }
                labels(first: 20) { nodes { name } }
              }
            }
          }
        }
      }
    }
  }
}`

const POINTS = /^(points?|story points?|estimate|size)$/i
const DAY = 86_400_000
const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10)

/** The iteration running today: started, and not yet past its duration. */
function currentIteration(iterations: { title: string; startDate: string; duration: number }[], now: number) {
  return iterations.find(it => {
    const start = Date.parse(`${it.startDate}T00:00:00Z`)
    return start <= now && now < start + it.duration * DAY
  })
}

function storyFrom(issue: Issue, column: string, isOffSprint: boolean, points?: number): Story {
  const tags = issue.labels.nodes.map(l => l.name)
  return {
    id: issue.number,
    type: tags.some(t => /bug/i.test(t)) ? 'Bug' : 'Issue',
    title: issue.title,
    column,
    state: issue.state,
    tags,
    tier: tags.find(t => /^tier:/i.test(t))?.slice(5).toUpperCase(),
    points,
    priority: 9,
    rank: issue.number,
    isOffSprint,
    iteration: '',
    url: issue.url,
    tasks: [],
    prs: [],
  }
}

/** A GitHub Project's board: its Status columns, and your issues in the repo, split by the current iteration. */
async function projectBoard(config: GitHubConfig, login: string, now: number): Promise<{ sprint: Sprint; stories: Story[]; columns: string[] }> {
  const { owner } = split(config.repo)
  const items: ProjectItem[] = []
  let after: string | null = null
  let project: NonNullable<NonNullable<ProjectData['repositoryOwner']>['projectV2']> | null = null
  do {
    const data: ProjectData = await graphql<ProjectData>(PROJECT_QUERY, { owner, number: config.projectNumber, after })
    project = data.repositoryOwner?.projectV2 ?? null
    if (!project) throw new Error(`No GitHub Project #${config.projectNumber} on ${owner}`)
    items.push(...project.items.nodes)
    after = project.items.pageInfo.hasNextPage ? project.items.pageInfo.endCursor : null
  } while (after)

  const status = project.fields.nodes.find(f => f.name === 'Status' && f.options)
  const columns = status?.options?.map(o => o.name) ?? ['Todo', 'In Progress', 'Done']
  const iterationField = project.fields.nodes.find(f => f.configuration?.iterations)
  const current = iterationField ? currentIteration(iterationField.configuration!.iterations, now) : undefined
  const sprint: Sprint = current
    ? {
        name: current.title,
        path: current.title,
        start: current.startDate,
        finish: isoDate(Date.parse(`${current.startDate}T00:00:00Z`) + (current.duration - 1) * DAY),
      }
    : { name: project.title, path: '', start: '', finish: '' }

  const stories: Story[] = []
  for (const item of items) {
    const issue = item.content
    if (!issue || issue.__typename !== 'Issue') continue
    if (issue.repository && issue.repository.nameWithOwner.toLowerCase() !== config.repo.toLowerCase()) continue
    if (!issue.assignees.nodes.some(a => a.login === login)) continue
    const values = item.fieldValues.nodes
    const column = values.find(v => v.field?.name === 'Status')?.name ?? columns[0] ?? 'Todo'
    const iteration = values.find(v => v.field?.name === iterationField?.name)?.title
    const isOffSprint = Boolean(current) && iteration !== current?.title
    // Off-sprint work that is already done is history, not something to plan.
    if (isOffSprint && (issue.state === 'CLOSED' || column === columns[columns.length - 1])) continue
    stories.push(storyFrom(issue, column, isOffSprint, values.find(v => POINTS.test(v.field?.name ?? ''))?.number))
  }

  return { sprint, stories, columns }
}

type SearchIssues = { search: { nodes: (Issue & { closedAt?: string | null })[] } }

const ISSUE_FIELDS = `number title url state closedAt repository { nameWithOwner } assignees(first: 10) { nodes { login } } labels(first: 20) { nodes { name } }`

/** Without a Project: your open issues in the repo, plus ones closed in the last two weeks, in three plain columns. */
async function issuesBoard(config: GitHubConfig, now: number): Promise<{ sprint: Sprint; stories: Story[]; columns: string[] }> {
  const since = isoDate(now - 14 * DAY)
  const [open, closed] = await Promise.all([
    graphql<SearchIssues>(`query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on Issue { ${ISSUE_FIELDS} } } } }`, {
      q: `repo:${config.repo} is:issue is:open assignee:@me`,
    }),
    graphql<SearchIssues>(`query($q: String!) { search(query: $q, type: ISSUE, first: 50) { nodes { ... on Issue { ${ISSUE_FIELDS} } } } }`, {
      q: `repo:${config.repo} is:issue is:closed assignee:@me closed:>=${since}`,
    }),
  ])
  const columns = ['Todo', 'In Progress', 'Done']
  const stories = [
    ...open.search.nodes.map(issue =>
      storyFrom(issue, issue.labels.nodes.some(l => /progress|doing/i.test(l.name)) ? 'In Progress' : 'Todo', false),
    ),
    ...closed.search.nodes.map(issue => storyFrom(issue, 'Done', false)),
  ]

  return { sprint: { name: config.repo, path: '', start: '', finish: '' }, stories, columns }
}

type PullNode = {
  number: number
  title: string
  url: string
  isDraft: boolean
  headRefName: string
  createdAt: string
  author: { login: string } | null
  reviews: { nodes: { state: string; author: { login: string } | null }[] }
  reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: { author: { login: string } | null }[] } }[] }
  closingIssuesReferences: { nodes: { number: number }[] }
}

const PULL_FIELDS = `number title url isDraft headRefName createdAt author { login }
  reviews(last: 30) { nodes { state author { login } } }
  reviewThreads(first: 100) { nodes { isResolved comments(first: 1) { nodes { author { login } } } } }
  closingIssuesReferences(first: 5) { nodes { number } }`

async function pulls(query: string): Promise<PullNode[]> {
  const data = await graphql<{ search: { nodes: PullNode[] } }>(
    `query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${PULL_FIELDS} } } } }`,
    { q: query },
  )
  return data.search.nodes.filter(n => n && typeof n.number === 'number')
}

/** Each reviewer's latest verdict: approved, changes requested, or neither. */
function verdicts(pr: PullNode) {
  const latest = new Map<string, string>()
  for (const review of pr.reviews.nodes) {
    if (review.author && review.state !== 'COMMENTED') latest.set(review.author.login, review.state)
  }
  const states = [...latest.values()]
  return { approvals: states.filter(s => s === 'APPROVED').length, changes: states.filter(s => s === 'CHANGES_REQUESTED').length }
}

/** Your open PRs, tied to the issues they close (or name in their branch). */
async function myPullsByIssue(config: GitHubConfig, login: string): Promise<Map<number, Pr[]>> {
  const byIssue = new Map<number, Pr[]>()
  for (const pr of await pulls(`repo:${config.repo} is:pr is:open author:@me`)) {
    const linked = pr.closingIssuesReferences.nodes.map(n => n.number)
    const fromBranch = /(?:^|\/)(\d+)[-_]/.exec(pr.headRefName)
    const issues = linked.length > 0 ? linked : fromBranch ? [Number(fromBranch[1])] : []
    const { approvals, changes } = verdicts(pr)
    const entry: Pr = {
      id: pr.number,
      title: pr.title,
      branch: pr.headRefName,
      isDraft: pr.isDraft,
      url: pr.url,
      vote: changes > 0 ? -10 : approvals > 0 ? 10 : 0,
      isCompleted: false,
      openThreads: pr.reviewThreads.nodes.filter(t => !t.isResolved && t.comments.nodes[0]?.author?.login !== login).length,
    }
    for (const issue of issues) byIssue.set(issue, [...(byIssue.get(issue) ?? []), entry])
  }

  return byIssue
}

export async function readGitHubBoard(config: GitHubConfig, now: number): Promise<Board> {
  const login = await me()
  const base = config.projectNumber ? await projectBoard(config, login, now) : await issuesBoard(config, now)
  const prs = await myPullsByIssue(config, login)
  for (const story of base.stories) story.prs = prs.get(story.id) ?? []

  return { ...base, fetchedAt: now }
}

/** Other people's open PRs in the repo, oldest first: what the reviewer works through. */
export async function gitHubReviewQueue(config: GitHubConfig): Promise<ReviewPr[]> {
  const list = await pulls(`repo:${config.repo} is:pr is:open -author:@me`)
  return list
    .map(pr => {
      const { approvals, changes } = verdicts(pr)
      return {
        id: pr.number,
        title: pr.title,
        author: pr.author?.login ?? 'someone',
        createdAt: pr.createdAt,
        isDraft: pr.isDraft,
        approvals,
        changesAsked: changes,
        url: pr.url,
      }
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}
