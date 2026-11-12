import { useEffect, useState } from 'react'

import { reviewThreads } from '../../shared/model'
import type { HealthCheck, LogEntry, NewProject, Pin, ProjectSummary, ReviewPr, Settings, Story, TerminalInfo, WorkflowChoice } from '../../shared/types'
import { api, clearPageErrors, onPageError, pageErrors } from './api'

export type InboxItem = { key: string; title: string; reason: string; tone: 'pink' | 'yellow' | 'red' }

const ticketOf = (key: string) => key.replace(/-shell$/, '')

/** Everything waiting on you: a Claude asking or done with its turn, and PRs with review threads. */
export function inboxItems(terminals: TerminalInfo[], stories: Map<string, Story>, pins: Pin[] = []): InboxItem[] {
  const items: InboxItem[] = []
  for (const t of terminals.filter(t => t.needsYou)) {
    const story = stories.get(ticketOf(t.key))
    items.push({
      key: t.key,
      title: pinTitle(pins, t.key) ?? (story ? `${story.id} · ${story.title}` : t.key),
      reason: t.state === 'asking' ? 'Claude is asking you something' : 'Claude finished its turn',
      tone: t.state === 'asking' ? 'pink' : 'yellow',
    })
  }
  for (const story of stories.values()) {
    const threads = reviewThreads(story)
    if (threads > 0) {
      items.push({
        key: String(story.id),
        title: `${story.id} · ${story.title}`,
        reason: `${threads} review thread${threads === 1 ? '' : 's'} to answer`,
        tone: 'red',
      })
    }
  }

  return items
}

const pinTitle = (pins: Pin[], key: string) => {
  const pin = pins.find(p => p.key === key)
  return pin && `${pin.icon} ${pin.label}`
}

export function Inbox({ items, onOpen, onClose }: { items: InboxItem[]; onOpen: (key: string) => void; onClose: () => void }) {
  return (
    <div className="popover" onMouseLeave={onClose}>
      <h3>Needs you</h3>
      {items.length === 0 && <p className="count">Nothing is waiting on you.</p>}
      {items.map(item => (
        <button
          key={`${item.key}-${item.tone}`}
          className="inbox-row"
          onClick={() => {
            onOpen(item.key)
            onClose()
          }}
        >
          <span className={`tag ${item.tone}`}>{item.reason}</span>
          <span className="inbox-title">{item.title}</span>
        </button>
      ))}
    </div>
  )
}

export function Setup({ onClose }: { onClose: () => void }) {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null)
  const [settings, setSettings] = useState<Settings | null>(null)
  const [note, setNote] = useState<string>()

  const recheck = () => {
    setChecks(null)
    void api.health().then(setChecks)
  }
  useEffect(() => {
    recheck()
    void api.settings().then(setSettings)
  }, [])

  const field = (key: 'name' | 'repoPath' | 'baseRef' | 'shell' | 'claudeCommand' | 'commandTemplate' | 'syncTasksCommand', label: string) =>
    settings && (
      <label className="field">
        <span>{label}</span>
        <input value={settings[key]} onChange={event => setSettings({ ...settings, [key]: event.target.value })} />
      </label>
    )

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={event => event.stopPropagation()}>
        <div className="modal-head">
          <h3>Setup</h3>
          <button className="tool" onClick={recheck}>
            ⟳ Check again
          </button>
          <button className="tool" onClick={onClose}>
            ✕
          </button>
        </div>

        <ul className="checks">
          {checks === null && <li className="count">Checking…</li>}
          {checks?.map(check => (
            <li key={check.name} className={check.isOk ? 'ok' : 'bad'}>
              <span className="mark">{check.isOk ? '✓' : '!'}</span>
              <div>
                <strong>{check.name}</strong>
                <div className="count">{check.detail}</div>
                {!check.isOk && check.fix && <code>{check.fix}</code>}
              </div>
            </li>
          ))}
        </ul>

        {settings && (
          <form
            className="settings"
            onSubmit={event => {
              event.preventDefault()
              void api.saveSettings(settings).then(saved => {
                setSettings(saved)
                setNote('Saved. New terminals use these settings.')
                recheck()
              })
            }}
          >
            <h3>Project</h3>
            {field('name', 'Name')}
            <label className="field">
              <span>Workflow</span>
              <select value={settings.workflow} onChange={e => setSettings({ ...settings, workflow: e.target.value as WorkflowChoice })}>
                <option value="auto">Auto (AI-DLC if the repo has ai-dlc.json)</option>
                <option value="aidlc">AI-DLC stage commands</option>
                <option value="plain">Plain: one command per card</option>
              </select>
            </label>
            {field('commandTemplate', 'Plain card command')}
            {field('syncTasksCommand', 'Sync stage tasks command')}
            <label className="field">
              <span>Focus hours a day</span>
              <input
                type="number"
                min={1}
                max={12}
                value={settings.focusHoursPerDay}
                onChange={e => setSettings({ ...settings, focusHoursPerDay: Number(e.target.value) || settings.focusHoursPerDay })}
              />
            </label>
            <TrackerFields
              tracker={settings.tracker}
              ado={settings.ado}
              github={settings.github}
              onChange={patch => setSettings({ ...settings, ...patch })}
            />
            <h3>Terminals</h3>
            {field('repoPath', 'Repo folder')}
            {field('baseRef', 'Worktrees cut from')}
            {field('shell', 'Shell')}
            {field('claudeCommand', 'Claude command')}
            <label className="field check">
              <input
                type="checkbox"
                checked={settings.useWorktrees}
                onChange={event => setSettings({ ...settings, useWorktrees: event.target.checked })}
              />
              <span>One git worktree per ticket</span>
            </label>
            <PinEditor pins={settings.pins} onChange={pins => setSettings({ ...settings, pins })} />
            <div className="settings-foot">
              {note && <span className="count">{note}</span>}
              <div className="spacer" />
              <button className="tool primary" type="submit">
                Save
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  )
}

/** Whether any setup check fails, for the toolbar badge. */
export function useSetupProblems() {
  const [count, setCount] = useState(0)
  useEffect(() => {
    void api
      .health()
      .then(checks => setCount(checks.filter(c => !c.isOk).length))
      .catch(() => setCount(0))
  }, [])

  return count
}

/** The 🐞 button beside the sprint title: the server's and the page's recent failures, newest first. */
export function DebugLog() {
  const [server, setServer] = useState<LogEntry[]>([])
  const [, setTick] = useState(0)
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    const load = () => void api.serverLog().then(setServer).catch(() => undefined)
    load()
    const timer = setInterval(load, 5_000)
    const stop = onPageError(() => setTick(n => n + 1))
    return () => {
      clearInterval(timer)
      stop()
    }
  }, [])

  const entries = [...server, ...pageErrors()].sort((a, b) => b.at - a.at)

  return (
    <div className="pop-host">
      <button className={`tool${entries.length > 0 ? ' alert' : ''}`} onClick={() => setIsOpen(!isOpen)}>
        🐞 Debug {entries.length > 0 && <span className="badge">{entries.length}</span>}
      </button>
      {isOpen && (
        <div className="popover debug">
          <div className="modal-head">
            <h3>Debug log</h3>
            <button
              className="tool"
              onClick={() => {
                clearPageErrors()
                void api.clearServerLog().then(setServer)
              }}
            >
              Clear
            </button>
            <button className="tool" onClick={() => setIsOpen(false)}>
              ✕
            </button>
          </div>
          {entries.length === 0 && <p className="count">No errors since the last clear.</p>}
          {entries.map((entry, at) => (
            <div key={`${entry.at}-${at}`} className="log-row">
              <div className="log-meta">
                <span className={`tag ${entry.side === 'server' ? 'purple' : 'blue'}`}>{entry.side}</span>
                <span className="count">{new Date(entry.at).toLocaleTimeString()}</span>
                <strong>{entry.source}</strong>
              </div>
              <code>{entry.message}</code>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** The pins, editable in Setup: icon, name, what each press does, and its prompt. */
function PinEditor({ pins, onChange }: { pins: Pin[]; onChange: (pins: Pin[]) => void }) {
  const change = (at: number, patch: Partial<Pin>) => onChange(pins.map((p, i) => (i === at ? { ...p, ...patch } : p)))

  return (
    <div className="pins-editor">
      <h3>Pinned chats</h3>
      <p className="count">
        <strong>Keep chat</strong> reopens one conversation and sends the prompt only the first time. <strong>Fresh run</strong>{' '}
        starts a new conversation with the prompt on every press. <code>{'{sprint}'}</code> becomes the sprint's name.
      </p>
      {pins.map((pin, at) => (
        <div key={`${pin.key}-${at}`} className="pin-row">
          <input className="pin-icon" value={pin.icon} onChange={e => change(at, { icon: e.target.value })} aria-label="Icon" />
          <input value={pin.label} placeholder="Name" onChange={e => change(at, { label: e.target.value })} aria-label="Name" />
          <select value={pin.mode} onChange={e => change(at, { mode: e.target.value as Pin['mode'] })} aria-label="Mode">
            <option value="fresh">Fresh run</option>
            <option value="resume">Keep chat</option>
          </select>
          <button type="button" className="tool" title="Remove pin" onClick={() => onChange(pins.filter((_, i) => i !== at))}>
            ✕
          </button>
          <input
            className="pin-prompt"
            value={pin.prompt}
            placeholder="Prompt or command, e.g. /aidlc-status or: summarise {sprint}"
            onChange={e => change(at, { prompt: e.target.value })}
            aria-label="Prompt"
          />
        </div>
      ))}
      <button
        type="button"
        className="tool"
        onClick={() => onChange([...pins, { key: '', label: 'New pin', icon: '📌', prompt: '', mode: 'fresh' }])}
      >
        + Add pin
      </button>
    </div>
  )
}

const daysOld = (iso: string) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86_400_000))

/**
 * The review queue: other people's active PRs, from ADO. Each action is a line typed
 * into the Reviewer terminal, which follows your reviewer brief; it never posts unasked.
 */
export function Reviews(props: {
  reviews: ReviewPr[]
  isReviewerUp: boolean
  onStartReviewer: () => void
  onSend: (text: string) => void
  onClose: () => void
}) {
  const { reviews, isReviewerUp } = props
  const waiting = reviews.filter(r => !r.isDraft && r.approvals === 0)

  return (
    <div className="popover reviews">
      <div className="modal-head">
        <h3>Reviews · {waiting.length} waiting</h3>
        {isReviewerUp ? (
          <>
            <button className="tool" onClick={() => props.onSend('Run a review tick now, following your brief.')}>
              ▶ Run tick
            </button>
            <button
              className="tool"
              onClick={() => confirm('Post every drafted review that is waiting?') && props.onSend('post all')}
            >
              Post all
            </button>
          </>
        ) : (
          <button className="tool primary" onClick={props.onStartReviewer}>
            ▶ Start reviewer
          </button>
        )}
        <button className="tool" onClick={props.onClose}>
          ✕
        </button>
      </div>
      {!isReviewerUp && (
        <p className="count">The Reviewer isn't running. Starting it runs its first tick over every PR below.</p>
      )}
      {reviews.length === 0 && <p className="count">No open PRs from anyone else.</p>}
      {reviews.map(pr => (
        <div key={pr.id} className="review-row">
          <div className="review-main">
            <a href={pr.url} target="_blank" rel="noreferrer">
              <strong>PR {pr.id}</strong>
            </a>{' '}
            {pr.title}
            <div className="review-meta">
              <span className="count">
                {pr.author} · {daysOld(pr.createdAt)}d
              </span>
              {pr.isDraft && <span className="tag gray">draft</span>}
              {pr.approvals > 0 && <span className="tag green">✓ {pr.approvals} approved</span>}
              {pr.changesAsked > 0 && <span className="tag red">changes asked</span>}
            </div>
          </div>
          <div className="review-actions">
            <button
              className="tool"
              disabled={!isReviewerUp}
              onClick={() => props.onSend(`Draft a review of PR ${pr.id} now, following your brief.`)}
            >
              Draft
            </button>
            <button
              className="tool"
              disabled={!isReviewerUp}
              onClick={() => confirm(`Post the drafted review of PR ${pr.id}?`) && props.onSend(`post ${pr.id}`)}
            >
              Post
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}

/** ＋ Pin: one new pinned chat, saved straight into the settings. */
export function AddPin({ onSaved, onClose }: { onSaved: () => void; onClose: () => void }) {
  const [pin, setPin] = useState<Pin>({ key: '', label: '', icon: '📌', prompt: '', mode: 'fresh' })
  const [error, setError] = useState<string>()

  return (
    <div className="popover add-pin">
      <div className="modal-head">
        <h3>New pinned chat</h3>
        <button className="tool" onClick={onClose}>
          ✕
        </button>
      </div>
      <form
        onSubmit={event => {
          event.preventDefault()
          if (!pin.label.trim()) {
            setError('Give it a name.')
            return
          }
          void api
            .settings()
            .then(settings => api.saveSettings({ ...settings, pins: [...settings.pins, pin] }))
            .then(() => {
              onSaved()
              onClose()
            })
            .catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
        }}
      >
        <div className="pin-row">
          <input className="pin-icon" value={pin.icon} onChange={e => setPin({ ...pin, icon: e.target.value })} aria-label="Icon" />
          <input autoFocus value={pin.label} placeholder="Name" onChange={e => setPin({ ...pin, label: e.target.value })} aria-label="Name" />
          <select value={pin.mode} onChange={e => setPin({ ...pin, mode: e.target.value as Pin['mode'] })} aria-label="Mode">
            <option value="fresh">Fresh run</option>
            <option value="resume">Keep chat</option>
          </select>
          <button className="tool primary" type="submit">
            Add
          </button>
          <input
            className="pin-prompt"
            value={pin.prompt}
            placeholder="Prompt or command, e.g. /aidlc-status or: summarise {sprint}"
            onChange={e => setPin({ ...pin, prompt: e.target.value })}
            aria-label="Prompt"
          />
        </div>
      </form>
      {error && <p className="error">{error}</p>}
      <p className="count">Edit or remove pins later in ⚙ Setup.</p>
    </div>
  )
}

const EMPTY_ADO = { org: '', project: '', repo: '', tenant: '', areaPath: '', team: '' }

/** The tracker's own settings: Azure DevOps org and team, or a GitHub repo and optional Project. */
function TrackerFields(props: {
  tracker: NewProject['tracker']
  ado?: NewProject['ado']
  github?: NewProject['github']
  onChange: (patch: Partial<Pick<NewProject, 'ado' | 'github'>>) => void
}) {
  if (props.tracker === 'ado') {
    const ado = props.ado ?? EMPTY_ADO
    const input = (key: keyof typeof EMPTY_ADO, label: string, hint: string) => (
      <label className="field">
        <span>{label}</span>
        <input value={ado[key]} placeholder={hint} onChange={e => props.onChange({ ado: { ...ado, [key]: e.target.value } })} />
      </label>
    )
    return (
      <>
        {input('org', 'ADO organisation', 'my-org')}
        {input('project', 'ADO project', 'My Project')}
        {input('team', 'Team (its sprints and board)', 'My Team')}
        {input('repo', 'Git repository', 'my-repo')}
        {input('areaPath', 'Area path', 'My Project\\Area')}
        {input('tenant', 'Entra tenant id', 'for az login --tenant')}
      </>
    )
  }
  const github = props.github ?? { repo: '' }
  return (
    <>
      <label className="field">
        <span>GitHub repository</span>
        <input value={github.repo} placeholder="owner/name" onChange={e => props.onChange({ github: { ...github, repo: e.target.value } })} />
      </label>
      <label className="field">
        <span>Project number (optional)</span>
        <input
          value={github.projectNumber ?? ''}
          placeholder="Its Status field becomes the columns"
          onChange={e => props.onChange({ github: { ...github, projectNumber: Number(e.target.value) || undefined } })}
        />
      </label>
    </>
  )
}

/** A new project: a name, a repo on disk, and its tracker. The board reads it straight away. */
export function NewProjectForm({ onCreated, onCancel }: { onCreated: (project: ProjectSummary) => void; onCancel?: () => void }) {
  const [draft, setDraft] = useState<NewProject>({ name: '', repoPath: '', baseRef: 'origin/main', tracker: 'github', workflow: 'auto', github: { repo: '' } })
  const [error, setError] = useState<string>()
  const set = (patch: Partial<NewProject>) => setDraft({ ...draft, ...patch })

  return (
    <form
      className="settings new-project"
      onSubmit={event => {
        event.preventDefault()
        if (!draft.name.trim()) return setError('Give the project a name.')
        if (draft.tracker === 'github' && !/^[\w.-]+\/[\w.-]+$/.test(draft.github?.repo ?? '')) return setError('The GitHub repository should be owner/name.')
        if (draft.tracker === 'ado' && !(draft.ado?.org && draft.ado.project && draft.ado.team)) return setError('Azure DevOps needs an organisation, a project and a team.')
        void api
          .createProject(draft)
          .then(onCreated)
          .catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
      }}
    >
      <p className="count">One project per repo. Its board, pins, terminals and worktrees are kept apart from every other project's.</p>
      <label className="field">
        <span>Name</span>
        <input autoFocus value={draft.name} placeholder="My app" onChange={e => set({ name: e.target.value })} />
      </label>
      <label className="field">
        <span>Repo folder</span>
        <input value={draft.repoPath} placeholder="C:\\path\\to\\repo" onChange={e => set({ repoPath: e.target.value })} />
      </label>
      <label className="field">
        <span>Worktrees cut from</span>
        <input value={draft.baseRef} onChange={e => set({ baseRef: e.target.value })} />
      </label>
      <label className="field">
        <span>Tracker</span>
        <select value={draft.tracker} onChange={e => set({ tracker: e.target.value as NewProject['tracker'] })}>
          <option value="github">GitHub</option>
          <option value="ado">Azure DevOps</option>
        </select>
      </label>
      <TrackerFields tracker={draft.tracker} ado={draft.ado} github={draft.github} onChange={set} />
      <label className="field">
        <span>Workflow</span>
        <select value={draft.workflow} onChange={e => set({ workflow: e.target.value as WorkflowChoice })}>
          <option value="auto">Auto (AI-DLC if the repo has ai-dlc.json)</option>
          <option value="aidlc">AI-DLC stage commands</option>
          <option value="plain">Plain: one command per card</option>
        </select>
      </label>
      {error && <p className="error">{error}</p>}
      <div className="settings-foot">
        <span className="count">GitHub signs in through the gh CLI (or GH_TOKEN); Azure DevOps through az login.</span>
        <div className="spacer" />
        {onCancel && (
          <button type="button" className="tool" onClick={onCancel}>
            Cancel
          </button>
        )}
        <button type="submit" className="tool primary">
          Create project
        </button>
      </div>
    </form>
  )
}
