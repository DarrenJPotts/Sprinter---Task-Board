import { execFile } from 'node:child_process'

import type { Board, Pr, ReviewPr, Sprint, Story, Task } from '../shared/types.js'

import type { AdoConfig } from './config.js'

/** How the board reads ADO, passed in so the reader runs against a fake in tests. */
export type AdoIo = {
  get: <T>(url: string) => Promise<T>
  post: <T>(url: string, body: unknown) => Promise<T>
  /** A JSON Patch, as ADO takes it for changing a work item. */
  patch: <T>(url: string, body: unknown) => Promise<T>
}

/** The team board's columns in order, from its requirement-level (Stories) board. */
async function boardColumns(io: AdoIo, config: AdoConfig): Promise<string[]> {
  const org = `https://dev.azure.com/${encodeURIComponent(config.org)}`
  const columnsOf = async (team: string) => {
    const root = `${org}/${encodeURIComponent(config.project)}/${encodeURIComponent(team)}`
    const boards = await io.get<{ value: { id: string; name: string }[] }>(`${root}/_apis/work/boards?api-version=7.1`)
    const board = boards.value.find(b => /stor|requirement|backlog item/i.test(b.name)) ?? boards.value[0]
    if (!board) return []
    const columns = await io.get<{ value: { name: string }[] }>(`${root}/_apis/work/boards/${board.id}/columns?api-version=7.1`)
    return columns.value.map(col => col.name)
  }
  try {
    return await columnsOf(config.boardTeam ?? config.team)
  } catch {
    // The sprint folder's name and the team's often differ ("Web Team" vs "Web"): try the closest team.
    const teams = await io.get<{ value: { name: string }[] }>(
      `${org}/_apis/projects/${encodeURIComponent(config.project)}/teams?$top=200&api-version=7.1`,
    )
    const want = config.team.toLowerCase().replace(/s*team$/, '')
    const match = teams.value.find(t => t.name.toLowerCase() === want) ?? teams.value.find(t => t.name.toLowerCase().startsWith(want))
    return match ? columnsOf(match.name) : []
  }
}

const base = (c: AdoConfig) =>
  `https://dev.azure.com/${encodeURIComponent(c.org)}/${encodeURIComponent(c.project)}`

type IterationNode = {
  name: string
  attributes?: { startDate?: string; finishDate?: string }
  children?: IterationNode[]
}

export async function currentSprint(
  io: AdoIo, config: AdoConfig,
  today: string,
): Promise<Sprint> {
  const root = await io.get<IterationNode>(`${base(config)}/_apis/wit/classificationnodes/iterations?$depth=4&api-version=7.1`,
  )
  const found: Sprint[] = []
  const walk = (node: IterationNode, path: string[]) => {
    const here = [...path, node.name]
    const { startDate, finishDate } = node.attributes ?? {}
    // A sprint sits below the team node; the team node carries dates of its own.
    const isUnderTeam = here.slice(0, -1).includes(config.team)
    if (isUnderTeam && startDate && finishDate) {
      found.push({ name: node.name, path: here.join('\\'), start: startDate, finish: finishDate })
    }
    node.children?.forEach(child => walk(child, here))
  }
  walk(root, [])

  const day = today.slice(0, 10)
  const now = found.find(s => s.start.slice(0, 10) <= day && day <= s.finish.slice(0, 10))
  const latest = [...found].sort((a, b) => b.start.localeCompare(a.start))[0]
  const sprint = now ?? latest
  if (!sprint) throw new Error(`No sprint under ${config.team}`)

  return sprint
}

async function wiql(io: AdoIo, config: AdoConfig, query: string): Promise<number[]> {
  const result = await io.post<{ workItems: { id: number }[] }>(
    `${base(config)}/_apis/wit/wiql?$top=200&api-version=7.1`,
    { query },
  )

  return result.workItems.map(item => item.id)
}

type WorkItem = {
  id: number
  fields: Record<string, unknown>
  relations?: { rel: string; url: string }[]
}

async function batch(
  io: AdoIo, config: AdoConfig,
  ids: number[],
  shape: { fields: string[] } | { $expand: 'Relations' },
): Promise<WorkItem[]> {
  const out: WorkItem[] = []
  for (let at = 0; at < ids.length; at += 200) {
    const page = await io.post<{ value: WorkItem[] }>(
      `${base(config)}/_apis/wit/workitemsbatch?api-version=7.1`,
      { ids: ids.slice(at, at + 200), ...shape },
    )
    out.push(...page.value)
  }

  return out
}

const quote = (text: string) => text.replace(/'/g, "''")
const num = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0) || 0)
const str = (value: unknown) => (typeof value === 'string' ? value : '')

/** Reads the developer's sprint: stories and bugs, their stage tasks and open PRs. */
export async function readBoard(io: AdoIo, config: AdoConfig, now: number): Promise<Board> {
  const sprint = await currentSprint(io, config, new Date(now).toISOString())
  // The requirement and bug categories cover every process: Agile's User Story, Scrum's Product
  // Backlog Item, CMMI's Requirement, Basic's Issue, and each one's Bug.
  const types = "([System.WorkItemType] IN GROUP 'Microsoft.RequirementCategory' OR [System.WorkItemType] IN GROUP 'Microsoft.BugCategory')"
  const scope = config.areaPath ? `[System.AreaPath] UNDER '${quote(config.areaPath)}'` : `[System.TeamProject] = '${quote(config.project)}'`

  const [inSprint, offSprint] = await Promise.all([
    wiql(
      io,
      config,
      `SELECT [System.Id] FROM WorkItems WHERE [System.IterationPath] = '${quote(sprint.path)}' AND [System.AssignedTo] = @Me AND ${types} AND [System.State] <> 'Removed'`,
    ),
    wiql(
      io,
      config,
      `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND ${types} AND ${scope} AND [System.IterationPath] <> '${quote(sprint.path)}' AND [System.State] NOT IN ('Done', 'Closed', 'Removed') AND [System.BoardColumn] <> 'Done'`,
    ),
  ])

  const items = await batch(io, config, [...inSprint, ...offSprint], { $expand: 'Relations' })
  const childIds = items.flatMap(item =>
    (item.relations ?? [])
      .filter(rel => rel.rel === 'System.LinkTypes.Hierarchy-Forward')
      .map(rel => Number(rel.url.split('/').pop())),
  )
  const children = await batch(io, config, childIds, {
    fields: [
      'System.Id',
      'System.Title',
      'System.State',
      'System.WorkItemType',
      'Microsoft.VSTS.Scheduling.RemainingWork',
      'Microsoft.VSTS.Scheduling.CompletedWork',
    ],
  })
  const tasks = new Map<number, Task>()
  for (const child of children) {
    if (str(child.fields['System.WorkItemType']) !== 'Task') continue
    tasks.set(child.id, {
      id: child.id,
      title: str(child.fields['System.Title']),
      state: str(child.fields['System.State']),
      remaining: num(child.fields['Microsoft.VSTS.Scheduling.RemainingWork']),
      completed: num(child.fields['Microsoft.VSTS.Scheduling.CompletedWork']),
    })
  }

  const prs = await myPullRequests(io, config)

  const stories: Story[] = items.map(item => {
    const f = item.fields
    const tags = str(f['System.Tags'])
      .split(';')
      .map(tag => tag.trim())
      .filter(Boolean)
    const childTasks = (item.relations ?? [])
      .filter(rel => rel.rel === 'System.LinkTypes.Hierarchy-Forward')
      .map(rel => tasks.get(Number(rel.url.split('/').pop())))
      .filter((task): task is Task => task !== undefined)
    const points = f['Microsoft.VSTS.Scheduling.StoryPoints']

    return {
      id: item.id,
      type: str(f['System.WorkItemType']),
      title: str(f['System.Title']),
      column: str(f['System.BoardColumn']) || str(f['System.State']),
      state: str(f['System.State']),
      tags,
      tier: tags.find(tag => /^tier:/i.test(tag))?.slice(5).toUpperCase(),
      points: points === undefined ? undefined : num(points),
      priority: num(f['Microsoft.VSTS.Common.Priority']) || 9,
      rank: num(f['Microsoft.VSTS.Common.StackRank']) || Number.MAX_SAFE_INTEGER,
      isOffSprint: str(f['System.IterationPath']) !== sprint.path,
      iteration: str(f['System.IterationPath']),
      url: `https://dev.azure.com/${config.org}/${encodeURIComponent(config.project)}/_workitems/edit/${item.id}`,
      tasks: childTasks,
      prs: prs.get(item.id) ?? [],
    }
  })

  const columns = await boardColumns(io, config).catch(() => [] as string[])
  // Any column a story sits in that the board call missed still gets a lane, after the known ones.
  for (const story of stories) if (!columns.includes(story.column)) columns.push(story.column)

  return { sprint, stories, columns, fetchedAt: now }
}

type PullRequest = {
  pullRequestId: number
  title: string
  sourceRefName: string
  status: string
  isDraft?: boolean
  closedDate?: string
  createdBy?: { id: string }
  reviewers?: { vote: number }[]
}

type Thread = {
  status?: string
  isDeleted?: boolean
  comments?: { commentType?: string; author?: { id?: string }; isDeleted?: boolean }[]
}

// A PR completed within this window still steers the card: it is the gate to close.
const RECENT_MS = 14 * 86_400_000

let me: string | null = null

/** Review threads still open with a comment from someone other than the author. */
async function openThreads(io: AdoIo, config: AdoConfig, pr: PullRequest): Promise<number> {
  const threads = await io.get<{ value: Thread[] }>(
    `${base(config)}/_apis/git/repositories/${encodeURIComponent(config.repo)}/pullRequests/${pr.pullRequestId}/threads?api-version=7.1`,
  )

  return threads.value.filter(
    thread =>
      !thread.isDeleted &&
      (thread.status === 'active' || thread.status === 'pending') &&
      (thread.comments ?? []).some(c => c.commentType === 'text' && !c.isDeleted && c.author?.id !== pr.createdBy?.id),
  ).length
}

async function whoAmI(io: AdoIo, config: AdoConfig): Promise<string> {
  if (!me) {
    const data = await io.get<{ authenticatedUser: { id: string } }>(
      `https://dev.azure.com/${encodeURIComponent(config.org)}/_apis/connectionData`,
    )
    me = data.authenticatedUser.id
  }

  return me
}

/** Active PRs in the repo that someone else opened: what the reviewer works through. */
export async function reviewQueue(io: AdoIo, config: AdoConfig): Promise<ReviewPr[]> {
  const mine = await whoAmI(io, config)
  const list = await io.get<{ value: (PullRequest & { creationDate: string; createdBy?: { id: string; displayName?: string } })[] }>(
    `${base(config)}/_apis/git/repositories/${encodeURIComponent(config.repo)}/pullrequests?searchCriteria.status=active&$top=200&api-version=7.1`,
  )

  return list.value
    .filter(pr => pr.createdBy?.id !== mine)
    .map(pr => {
      const votes = (pr.reviewers ?? []).map(r => r.vote)
      return {
        id: pr.pullRequestId,
        title: pr.title,
        author: pr.createdBy?.displayName ?? 'someone',
        createdAt: pr.creationDate,
        isDraft: pr.isDraft === true,
        approvals: votes.filter(v => v >= 5).length,
        changesAsked: votes.filter(v => v < 0).length,
        url: `https://dev.azure.com/${config.org}/${encodeURIComponent(config.project)}/_git/${config.repo}/pullrequest/${pr.pullRequestId}`,
      }
    })
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

async function myPullRequests(io: AdoIo, config: AdoConfig): Promise<Map<number, Pr[]>> {
  if (!me) {
    const data = await io.get<{ authenticatedUser: { id: string } }>(
      `https://dev.azure.com/${encodeURIComponent(config.org)}/_apis/connectionData`,
    )
    me = data.authenticatedUser.id
  }
  const list = (status: string, top: number) =>
    io.get<{ value: PullRequest[] }>(
      `${base(config)}/_apis/git/repositories/${encodeURIComponent(config.repo)}/pullrequests?searchCriteria.status=${status}&searchCriteria.creatorId=${me}&$top=${top}&api-version=7.1`,
    )
  const [active, completed] = await Promise.all([list('active', 100), list('completed', 30)])
  const recent = completed.value.filter(pr => pr.closedDate && Date.now() - Date.parse(pr.closedDate) < RECENT_MS)

  const byItem = new Map<number, Pr[]>()
  await Promise.all(
    [...active.value, ...recent].map(async pr => {
      const branch = pr.sourceRefName.replace(/^refs\/heads\//, '')
      const match = /(?:^|\/)(?:spec|impl|feat)\/(\d+)-/.exec(`/${branch}`)
      if (!match) return
      const id = Number(match[1])
      const votes = (pr.reviewers ?? []).map(r => r.vote)
      const isCompleted = pr.status === 'completed'
      const entry: Pr = {
        id: pr.pullRequestId,
        title: pr.title,
        branch,
        isDraft: pr.isDraft === true,
        url: `https://dev.azure.com/${config.org}/${encodeURIComponent(config.project)}/_git/${config.repo}/pullrequest/${pr.pullRequestId}`,
        vote: votes.length === 0 ? 0 : Math.min(...votes),
        isCompleted,
        openThreads: isCompleted ? 0 : await openThreads(io, config, pr).catch(() => 0),
      }
      byItem.set(id, [...(byItem.get(id) ?? []), entry])
    }),
  )

  return byItem
}

// Azure DevOps' own resource id, for an az CLI token.
const ADO_RESOURCE = '499b84ac-1321-427f-aa17-267ca6975798'
const TOKEN_LIFE_MS = 45 * 60_000
let token: { value: string; at: number } | null = null

function azToken(tenant: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // az is az.cmd on Windows, which only a shell can run.
    execFile(
      'az',
      ['account', 'get-access-token', '--resource', ADO_RESOURCE, '--tenant', tenant, '--query', 'accessToken', '-o', 'tsv'],
      { shell: process.platform === 'win32', timeout: 60_000 },
      (error, stdout, stderr) => {
        const value = stdout.trim()
        if (error || !value) {
          reject(new Error(stderr.trim().split('\n').pop() || `az failed: run az login --tenant ${tenant}`))
        } else {
          resolve(value)
        }
      },
    )
  })
}

async function bearer(config: AdoConfig) {
  if (token && Date.now() - token.at < TOKEN_LIFE_MS) return token.value
  token = { value: await azToken(config.tenant), at: Date.now() }

  return token.value
}

async function adoCall<T>(config: AdoConfig, url: string, body?: unknown, isPatch = false): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await fetch(url, {
      method: isPatch ? 'PATCH' : body === undefined ? 'GET' : 'POST',
      headers: {
        Authorization: `Bearer ${await bearer(config)}`,
        'Content-Type': isPatch ? 'application/json-patch+json' : 'application/json',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (response.status === 401 && attempt === 0) {
      token = null
      continue
    }
    if (!response.ok) throw new Error(`ADO ${response.status}: ${(await response.text()).slice(0, 160)}`)

    return (await response.json()) as T
  }

  throw new Error(`ADO refused the token twice: run az login --tenant ${config.tenant}`)
}

export const nodeIo = (config: AdoConfig): AdoIo => ({
  get: url => adoCall(config, url),
  post: (url, body) => adoCall(config, url, body),
  patch: (url, body) => adoCall(config, url, body, true),
})

const COMPLETED = 'Microsoft.VSTS.Scheduling.CompletedWork'

/** Adds hours to a task's Completed Work and returns the new total. Fails, rather than overwrites, if someone changed the task meanwhile. */
export async function addCompletedWork(io: AdoIo, config: AdoConfig, taskId: number, hours: number): Promise<number> {
  const url = `${base(config)}/_apis/wit/workitems/${taskId}`
  const item = await io.get<{ rev: number; fields: Record<string, unknown> }>(`${url}?fields=${COMPLETED}&api-version=7.1`)
  const total = Math.round((num(item.fields[COMPLETED]) + hours) * 100) / 100
  await io.patch(`${url}?api-version=7.1`, [
    { op: 'test', path: '/rev', value: item.rev },
    { op: 'add', path: `/fields/${COMPLETED}`, value: total },
  ])

  return total
}
