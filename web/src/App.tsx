import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import { WHENS, order, remainingHours, reviewThreads, shortDate, workingDaysLeft } from '../../shared/model'
import { makeRules } from '../../shared/workflow'
import type { Rules } from '../../shared/workflow'
import type { PillColor } from '../../shared/model'
import type { BgTask, Pin, Prefs, ProjectSummary, Snapshot, Story, TerminalInfo, TokenUsage, When } from '../../shared/types'
import { api, setProject } from './api'
import { Card, Tag } from './Card'
import { AddPin, DebugLog, Inbox, NewProjectForm, Reviews, Setup, inboxItems, useSetupProblems } from './Panels'
import { activate, allTabs, closeTab as closeIn, emptyPane, moveTab, openTab as openIn, panes, setRatio, zoneAt } from './layout'
import type { LayoutNode, PaneNode, SplitNode, Zone } from './layout'
import { Sessions, TaskOutput, Tasks } from './Sessions'
import { Terminal } from './Terminal'
import { Tour } from './Tour'
import { tourSteps } from './tourSteps'
import { billed, compact, usageTitle } from './tokens'

// The pin the Reviews panel drives; Setup can change its prompt and mode.
const REVIEWER = 'reviewer'

type View = 'board' | 'plan'
type Theme = 'auto' | 'light' | 'dark'
const NEXT_THEME: Record<Theme, Theme> = { auto: 'light', light: 'dark', dark: 'auto' }
const THEME_LABEL: Record<Theme, string> = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' }

function useSystemDark() {
  const query = window.matchMedia('(prefers-color-scheme: dark)')
  const [isDark, setIsDark] = useState(query.matches)
  useEffect(() => {
    const change = () => setIsDark(query.matches)
    query.addEventListener('change', change)
    return () => query.removeEventListener('change', change)
  }, [query])

  return isDark
}
type Lane = { name: string; color: PillColor; stories: Story[]; when?: When }

// Per-browser conveniences: which lanes are tucked away and how wide the side panel is.
function useLocal<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? initial : (JSON.parse(raw) as T)
    } catch {
      return initial
    }
  })
  const set = useCallback(
    (next: T) => {
      setValue(next)
      try {
        localStorage.setItem(key, JSON.stringify(next))
      } catch {
        // Storage refused (private window): the choice lasts this visit only.
      }
    },
    [key],
  )

  return [value, set]
}

function ProjectApp({ project, onSwitch, onNew }: { project: string; onSwitch: (id: string) => void; onNew: () => void }) {
  const ns = `hq.${project}.`
  const [snap, setSnap] = useState<Snapshot | null>(null)
  const [problem, setProblem] = useState<string>()
  const [view, setView] = useLocal<View>(`${ns}view`, 'board')
  const [hidden, setHidden] = useLocal<string[]>(`${ns}hidden`, ['Done', 'Off-sprint'])
  const [sideWidth, setSideWidth] = useLocal(`${ns}sideWidth`, Math.min(640, Math.max(360, Math.round(window.innerWidth * 0.4))))
  const [layout, setLayout] = useLocal<LayoutNode | null>(`${ns}layout`, project === 'lcv' ? legacyLayout() : null)
  const layoutRef = useRef(layout)
  layoutRef.current = layout
  const [focusedPane, setFocusedPane] = useState<string | null>(null)
  const [dropAt, setDropAt] = useState<{ paneId: string; zone: Zone } | null>(null)
  // One pane can take the whole window; the board and the other panes wait behind it.
  const [zoomed, setZoomed] = useState<string | null>(null)
  const zoomedPane = panes(layout).find(p => p.id === zoomed)
  const tabs = allTabs(layout)
  const focused = panes(layout).find(p => p.id === focusedPane) ?? panes(layout)[0]
  const [dropOn, setDropOn] = useState<string>()
  const [isInboxOpen, setIsInboxOpen] = useState(false)
  const [isSetupOpen, setIsSetupOpen] = useState(false)
  const [isAddPinOpen, setIsAddPinOpen] = useState(false)
  const [isReviewsOpen, setIsReviewsOpen] = useState(false)
  const [isTourOpen, setIsTourOpen] = useState(false)
  const [isTasksOpen, setIsTasksOpen] = useState(false)
  const [isSessionsOpen, setIsSessionsOpen] = useState(false)
  const [outputTask, setOutputTask] = useState<BgTask | null>(null)
  // The tab being renamed in place, and what has been typed so far.
  const [renaming, setRenaming] = useState<{ key: string; draft: string } | null>(null)
  const setupProblems = useSetupProblems()
  const [theme, setTheme] = useLocal<Theme>('hq.theme', 'auto')
  const isSystemDark = useSystemDark()
  const isDark = theme === 'dark' || (theme === 'auto' && isSystemDark)

  useEffect(() => {
    if (theme === 'auto') delete document.documentElement.dataset.theme
    else document.documentElement.dataset.theme = theme
  }, [theme])

  const loadedBuild = useRef<string | undefined>(undefined)
  // The page polls every few seconds; an answer identical to the last must not redraw the board.
  const lastAnswer = useRef('')
  const run = useCallback(async (work: Promise<Snapshot>) => {
    try {
      const next = await work
      // A window left open across a rebuild would keep running the old page: reload it.
      // 'dev' means the built page is missing right now (a rebuild is under way): wait for the new one.
      if (loadedBuild.current && next.buildId !== loadedBuild.current && next.buildId !== 'dev') {
        location.reload()
        return
      }
      loadedBuild.current = next.buildId
      const text = JSON.stringify(next)
      if (text !== lastAnswer.current) {
        lastAnswer.current = text
        setSnap(next)
      }
      setProblem(undefined)
    } catch (caught) {
      setProblem(caught instanceof Error ? caught.message : String(caught))
    }
  }, [])

  useEffect(() => {
    void run(api.snapshot())
    // Often enough that a Claude waiting on you shows up within seconds; the server answers from memory.
    const timer = setInterval(() => void run(api.snapshot()), 4_000)
    return () => clearInterval(timer)
  }, [run])

  const board = snap?.board
  const prefs: Prefs = snap?.prefs ?? { when: {}, pinned: [] }
  const hints = snap?.hints ?? {}
  const live = new Set(snap?.terminals.filter(t => t.isAlive).map(t => t.key))
  const terminalOf = new Map<string, TerminalInfo>(snap?.terminals.map(t => [t.key, t]))
  const byId = useMemo(() => new Map(board?.stories.map(s => [String(s.id), s])), [board])
  const pins = snap?.pins ?? []
  const pinOf = (key: string | null) => pins.find(p => p.key === key)
  const inbox = inboxItems(snap?.terminals ?? [], byId, pins)
  const rules: Rules = useMemo(
    () => makeRules(snap?.workflow ?? 'plain', board?.columns ?? [], snap?.commandTemplate ?? ''),
    [snap?.workflow, board?.columns, snap?.commandTemplate],
  )
  const projectName = snap?.project.name ?? project

  // The tour opens by itself once per browser, the first time a board is on screen.
  const hasBoard = Boolean(board)
  useEffect(() => {
    if (!hasBoard) return
    let seen = true
    try {
      seen = localStorage.getItem('hq.tourSeen') === 'yes'
    } catch {
      seen = true
    }
    if (!seen) setIsTourOpen(true)
  }, [hasBoard])
  const closeTour = useCallback(() => {
    setIsTourOpen(false)
    try {
      localStorage.setItem('hq.tourSeen', 'yes')
    } catch {
      // Storage refused: the tour may open again next visit.
    }
  }, [])
  const reviewsWaiting = (snap?.reviews ?? []).filter(r => !r.isDraft && r.approvals === 0).length
  const usages = Object.values(snap?.usage ?? {})
  const today = usages.reduce((sum, u) => sum + u.today, 0)
  const total = usages.reduce((sum, u) => sum + billed(u), 0)

  useEffect(() => {
    document.title = `${inbox.length > 0 ? `(${inbox.length}) ` : ''}${projectName} · Sprinter`
  }, [inbox.length, projectName])

  const ordered = useMemo(() => (board ? order(board.stories, prefs, hints) : []), [board, prefs, hints])

  const lanes: Lane[] = useMemo(() => {
    if (view === 'plan') {
      return WHENS.map(w => ({
        name: w.label,
        when: w.value,
        color: (w.value === 'today' ? 'red' : w.value === 'later' ? 'gray' : 'blue') as PillColor,
        stories: ordered.filter(s => !rules.isDone(s) && rules.whenOf(s, prefs, hints[s.id]) === w.value),
      }))
    }
    return [
      ...rules.columns.map(column => ({
        name: column,
        color: rules.colorOf(column),
        stories: ordered.filter(s => !s.isOffSprint && s.column === column),
      })),
      {
        name: 'Other',
        color: 'gray' as PillColor,
        stories: ordered.filter(s => !s.isOffSprint && !rules.columns.includes(s.column)),
      },
      { name: 'Off-sprint', color: 'gray' as PillColor, stories: ordered.filter(s => s.isOffSprint) },
    ].filter(lane => lane.stories.length > 0)
  }, [view, ordered, prefs, hints, rules])

  const shown = lanes.filter(l => !hidden.includes(l.name))
  const tucked = lanes.filter(l => hidden.includes(l.name))

  const savePrefs = (next: Prefs) => {
    setSnap(s => (s ? { ...s, prefs: next } : s))
    void run(api.savePrefs(next))
  }
  const star = (id: number) =>
    savePrefs({
      ...prefs,
      pinned: prefs.pinned.includes(id) ? prefs.pinned.filter(n => n !== id) : [...prefs.pinned, id],
    })
  const moveTo = (id: string, when: When) => savePrefs({ ...prefs, when: { ...prefs.when, [id]: when } })

  // A tab opens in the pane you last used; one already open is shown where it is.
  const openTab = (key: string, into?: string) => {
    const opened = openIn(layoutRef.current, key, into ?? focused?.id)
    setLayout(opened.layout)
    setFocusedPane(opened.paneId)
  }
  const closeTab = (key: string) => setLayout(closeIn(layoutRef.current, key))
  // A blank Claude chat at the repo root in its own tab; its conversation is kept and resumes like any other.
  const newChat = (into?: string) => {
    const key = `chat-${Date.now().toString(36)}`
    void run(api.openTerminal(key, {}))
    openTab(key, into)
  }
  const isShown = (key: string) => panes(layout).some(p => p.active === key)
  const rename = (key: string, name: string) => void run(api.rename(key, name))
  const runningTasks = Object.values(snap?.tasks ?? {}).flat().filter(task => task.status === 'running').length
  const resumable = new Set(snap?.resumable ?? [])
  // Reopens a terminal as it was: the same Claude conversation with no new prompt, or a plain shell.
  const resume = (key: string) =>
    void run(api.openTerminal(key, key.endsWith('-shell') ? { isShellOnly: true } : {}))

  const startGrip = (event: React.PointerEvent) => {
    const startX = event.clientX
    const startW = sideWidth
    const grip = event.currentTarget
    grip.classList.add('dragging')
    const move = (e: PointerEvent) => setSideWidth(Math.min(1200, Math.max(320, startW + startX - e.clientX)))
    const up = () => {
      grip.classList.remove('dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  if (!board) {
    return (
      <div className="main">
        <div className="page-head">
          <div className="title-row">
            <ProjectSwitcher current={project} name={projectName} projects={snap?.projects ?? []} onSwitch={onSwitch} onNew={onNew} />
            <h1 className="page-title">{projectName}</h1>
            <div className="spacer" />
            <div className="head-tools">
              <DebugLog />
              <button className="tool" onClick={() => setIsSetupOpen(true)}>
                ⚙ Setup
              </button>
            </div>
          </div>
          <p className={problem || snap?.error ? 'error' : 'count'}>
            {problem ?? snap?.error ?? `Reading the board from ${snap?.project.tracker === 'github' ? 'GitHub' : 'Azure DevOps'}…`}
          </p>
          {(problem || snap?.error) && (
            <button className="tool" onClick={() => void run(api.refresh())}>
              ⟳ Try again
            </button>
          )}
        </div>
        {isSetupOpen && <Setup onClose={() => setIsSetupOpen(false)} />}
      </div>
    )
  }

  // A tracker without sprint dates (a plain GitHub repo) has no capacity to measure.
  const hasDates = Boolean(board.sprint.start && board.sprint.finish)
  const daysLeft = hasDates ? workingDaysLeft(new Date().toISOString(), board.sprint.finish) : 0
  const needs = board.stories
    .filter(s => !s.isOffSprint && !rules.isDone(s))
    .reduce((sum, s) => sum + remainingHours(s), 0)
  const avail = daysLeft * (snap?.focusHoursPerDay ?? 6)
  const isOver = needs > avail

  const tabLabel = (key: string) =>
    snap?.names[key]
      ? snap.names[key]!
      : isChatKey(key)
      ? chatLabel(key)
      : pinOf(key) ? `${pinOf(key)!.icon} ${pinOf(key)!.label}` : key.endsWith('-shell') ? `${key.replace(/-shell$/, '')} · shell` : key

  const dropOnPane = (event: React.DragEvent<HTMLDivElement>, pane: PaneNode) => {
    const key = event.dataTransfer.getData('text/hq-tab')
    setDropAt(null)
    if (!key) return
    event.preventDefault()
    const moved = moveTab(layoutRef.current, key, pane.id, zoneAt(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY))
    setLayout(moved.layout)
    if (moved.paneId) setFocusedPane(moved.paneId)
  }

  const renderPane = (pane: PaneNode) => {
    const current = pane.active
    const story = current && !pinOf(current) ? byId.get(current.replace(/-shell$/, '')) : undefined

    return (
      <div
        key={pane.id}
        className={`pane${pane.id === focused?.id && panes(layout).length > 1 ? ' focused' : ''}`}
        onMouseDown={() => setFocusedPane(pane.id)}
        onDragOver={event => {
          if (!event.dataTransfer.types.includes('text/hq-tab')) return
          event.preventDefault()
          const zone = zoneAt(event.currentTarget.getBoundingClientRect(), event.clientX, event.clientY)
          if (dropAt?.paneId !== pane.id || dropAt.zone !== zone) setDropAt({ paneId: pane.id, zone })
        }}
        onDragLeave={event => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropAt(null)
        }}
        onDrop={event => dropOnPane(event, pane)}
      >
        <div className="tabs">
          {tabGroups(pane.tabs, byId, pins, rules).map(group => (
            <div key={group.name} className="tab-group">
              <span className={`tag ${group.color}`}>{group.name}</span>
              {group.keys.map(key => (
                <div
                  key={key}
                  className={`tab${current === key ? ' on' : ''}`}
                  draggable
                  title="Drag onto a pane's edge to split it, or its middle to move the tab there"
                  onDragStart={event => {
                    event.dataTransfer.setData('text/hq-tab', key)
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onDragEnd={() => setDropAt(null)}
                  onClick={() => {
                    setLayout(activate(layoutRef.current, pane.id, key))
                    setFocusedPane(pane.id)
                  }}
                >
                  {live.has(key) && <span className={`dot ${terminalOf.get(key)?.state ?? ''}`} />}
                  {renaming?.key === key ? (
                    <input
                      autoFocus
                      className="rename"
                      value={renaming.draft}
                      onClick={event => event.stopPropagation()}
                      onChange={event => setRenaming({ key, draft: event.target.value })}
                      onBlur={() => setRenaming(null)}
                      onKeyDown={event => {
                        if (event.key === 'Enter') {
                          rename(key, renaming.draft)
                          setRenaming(null)
                        }
                        if (event.key === 'Escape') setRenaming(null)
                      }}
                    />
                  ) : (
                    <span onDoubleClick={() => setRenaming({ key, draft: tabLabel(key).replace(/^💬 /, '') })} title="Double-click to rename">
                      {tabLabel(key)}
                    </span>
                  )}
                  <button
                    className="x"
                    title="Close tab (the terminal keeps running)"
                    onClick={event => {
                      event.stopPropagation()
                      closeTab(key)
                    }}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          ))}
          <button className="tool pane-new" onClick={() => newChat(pane.id)} title="A new blank Claude chat in this pane">
            ＋ Chat
          </button>
          <button
            className="tool pane-zoom"
            title={zoomed === pane.id ? 'Back to the board' : 'Full screen: this pane fills the window'}
            onClick={() => setZoomed(zoomed === pane.id ? null : pane.id)}
          >
            {zoomed === pane.id ? '⤡ Exit full screen' : '⤢'}
          </button>
        </div>
        {story && (
          <TicketHead
            story={story}
            rules={rules}
            syncCommand={snap?.syncTasksCommand ?? ''}
            command={rules.nextCommand(story, hints[story.id])}
            why={hints[story.id]?.why}
            usage={snap?.usage[String(story.id)]}
            isLive={live.has(String(story.id))}
            canResume={resumable.has(String(story.id))}
            onResume={() => resume(String(story.id))}
            hasWorktree={snap?.worktrees.includes(String(story.id)) ?? false}
            onStart={prompt => {
              setLayout(activate(layoutRef.current, pane.id, String(story.id)))
              void run(api.openTerminal(String(story.id), { prompt }))
            }}
            onShell={() => {
              const key = `${story.id}-shell`
              void run(api.openTerminal(key, { isShellOnly: true }))
              openTab(key, pane.id)
            }}
            onStop={() => void run(api.closeTerminal(String(story.id)))}
            onRemove={() => {
              if (!confirm(`Remove the worktree for ${story.id}? Its terminals stop. Git refuses if it has uncommitted changes.`)) return
              void run(api.removeWorktree(String(story.id)))
              closeTab(`${story.id}-shell`)
            }}
          />
        )}
        {current && live.has(current) ? (
          <Terminal termKey={current} isDark={isDark} onExit={() => void run(api.snapshot())} />
        ) : current && snap?.scrollback.includes(current) ? (
          <>
            <div className="ended-bar">
              <span>Not running · its last screen, saved</span>
              {(resumable.has(current) || current.endsWith('-shell')) && (
                <button className="tool primary" onClick={() => resume(current)}>
                  ⟳ {current.endsWith('-shell') ? 'Reopen shell' : 'Resume chat'}
                </button>
              )}
            </div>
            <Terminal key={`saved-${current}`} termKey={current} isDark={isDark} onExit={() => undefined} />
          </>
        ) : (
          <div className="term-empty">
            {current && resumable.has(current) ? (
              <button className="tool primary" onClick={() => resume(current)}>
                ⟳ Resume chat
              </button>
            ) : pinOf(current) ? (
              `${pinOf(current)!.label} is not running. Press its pin to start it.`
            ) : (
              'No terminal for this ticket yet. Start its Claude session above.'
            )}
          </div>
        )}
        {dropAt?.paneId === pane.id && <div className={`drop-zone ${dropAt.zone}`} />}
      </div>
    )
  }

  const startSplitDrag = (event: React.PointerEvent<HTMLDivElement>, split: SplitNode) => {
    const box = event.currentTarget.parentElement!.getBoundingClientRect()
    const gutter = event.currentTarget
    gutter.classList.add('dragging')
    const move = (e: PointerEvent) => {
      const ratio = split.dir === 'row' ? (e.clientX - box.left) / box.width : (e.clientY - box.top) / box.height
      if (layoutRef.current) setLayout(setRatio(layoutRef.current, split.id, ratio))
    }
    const up = () => {
      gutter.classList.remove('dragging')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  const renderRoot = (node: LayoutNode): React.ReactNode => (zoomedPane ? renderPane(zoomedPane) : renderNode(node))

  const renderNode = (node: LayoutNode): React.ReactNode =>
    node.kind === 'pane' ? (
      renderPane(node)
    ) : (
      <div key={node.id} className={`split ${node.dir}`}>
        <div className="split-child" style={{ flexGrow: node.ratio }}>
          {renderNode(node.a)}
        </div>
        <div className={`split-gutter ${node.dir}`} onPointerDown={event => startSplitDrag(event, node)} />
        <div className="split-child" style={{ flexGrow: 1 - node.ratio }}>
          {renderNode(node.b)}
        </div>
      </div>
    )

  return (
    <div
      className={`app${tabs.length === 0 ? ' no-side' : ''}${zoomedPane ? ' zoomed' : ''}`}
      style={{ '--side-w': `${sideWidth}px` } as React.CSSProperties}
    >
      <div className="main">
        <div className="page-head">
          <div className="title-row">
            <ProjectSwitcher current={project} name={projectName} projects={snap?.projects ?? []} onSwitch={onSwitch} onNew={onNew} />
            <h1 className="page-title">{board.sprint.name}</h1>
            <div className="spacer" />
            <div className="head-tools">
              <button className="tool" onClick={() => setIsTourOpen(true)} title="Walk through the page">
                ? Tour
              </button>
              <DebugLog />
              <button className={`tool${setupProblems > 0 ? ' alert' : ''}`} onClick={() => setIsSetupOpen(true)}>
                ⚙ Setup {setupProblems > 0 && <span className="badge">{setupProblems}</span>}
              </button>
              <button className="tool" title="Colour mode" onClick={() => setTheme(NEXT_THEME[theme])}>
                {THEME_LABEL[theme]}
              </button>
            </div>
          </div>
          <div className="props">
            <div className="prop-name">📅 Dates</div>
            <div className="prop-value">
              {hasDates ? `${shortDate(board.sprint.start)} → ${shortDate(board.sprint.finish)}` : 'No sprint dates on this board'}
            </div>
            {hasDates && (
              <>
                <div className="prop-name">⏳ Days left</div>
                <div className="prop-value">{daysLeft} working days</div>
                <div className="prop-name">⚖️ Load</div>
                <div className="prop-value">
                  <div className={`bar${isOver ? ' over' : ''}`}>
                    <div style={{ width: `${Math.min(100, avail ? (needs / avail) * 100 : 100)}%` }} />
                  </div>
                  <span className="count">
                    {needs} h of {avail} h{isOver ? ` · over by ${needs - avail} h` : ''}
                  </span>
                </div>
              </>
            )}
            <div className="prop-name">🧭 Workflow</div>
            <div className="prop-value">{rules.workflow === 'aidlc' ? 'AI-DLC stage commands' : 'Plain: one command per card'}</div>
            {(problem || snap?.error) && (
              <>
                <div className="prop-name">⚠️ Status</div>
                <div className="prop-value error">{problem ?? snap?.error}</div>
              </>
            )}
          </div>
        </div>

        <div className="views">
          <button className={`view${view === 'board' ? ' on' : ''}`} onClick={() => setView('board')}>
            ▦ Board
          </button>
          <button className={`view${view === 'plan' ? ' on' : ''}`} onClick={() => setView('plan')}>
            ☰ Plan
          </button>
          <span className="divider" />
          <span className="tool static" title={`All ticket sessions: ${compact(total)} tokens in total. Cache reads not counted.`}>
            🪙 Today {compact(today)}
          </span>
          <PopHost
            isOpen={isReviewsOpen}
            button={
              <button className="tool" onClick={() => setIsReviewsOpen(!isReviewsOpen)}>
                🔎 Reviews {reviewsWaiting > 0 && <span className="badge">{reviewsWaiting}</span>}
              </button>
            }
          >
            {(
              <Reviews
                reviews={snap?.reviews ?? []}
                isReviewerUp={terminalOf.get(REVIEWER)?.isAlive === true}
                onStartReviewer={() => {
                  void run(api.openPin(REVIEWER))
                  openTab(REVIEWER)
                }}
                onSend={text => {
                  void run(api.sendLine(REVIEWER, text))
                  openTab(REVIEWER)
                }}
                onClose={() => setIsReviewsOpen(false)}
              />
            )}
          </PopHost>
          <PopHost
            isOpen={isInboxOpen}
            button={
              <button className={`tool${inbox.length > 0 ? ' alert' : ''}`} onClick={() => setIsInboxOpen(!isInboxOpen)}>
                🔔 Needs you {inbox.length > 0 && <span className="badge">{inbox.length}</span>}
              </button>
            }
          >
            <Inbox items={inbox} onOpen={openTab} onClose={() => setIsInboxOpen(false)} />
          </PopHost>
          <button className="tool" onClick={() => void run(api.refresh())}>
            ⟳ Refresh
          </button>
          <PopHost
            isOpen={isTasksOpen}
            button={
              <button className="tool" onClick={() => setIsTasksOpen(!isTasksOpen)} title="Background shell commands and agents your chats started">
                🧵 Tasks {runningTasks > 0 && <span className="badge">{runningTasks}</span>}
              </button>
            }
          >
            <Tasks
              tasks={snap?.tasks ?? {}}
              label={tabLabel}
              onOpen={key => {
                setIsTasksOpen(false)
                openTab(key)
              }}
              onShowOutput={setOutputTask}
              onClose={() => setIsTasksOpen(false)}
            />
          </PopHost>
          <PopHost
            isOpen={isSessionsOpen}
            button={
              <button className="tool" onClick={() => setIsSessionsOpen(!isSessionsOpen)} title="Every saved Claude session in this project">
                📚 Sessions
              </button>
            }
          >
            <Sessions
              sessions={snap?.sessions ?? []}
              terminals={snap?.terminals ?? []}
              label={tabLabel}
              onOpen={key => {
                setIsSessionsOpen(false)
                openTab(key)
              }}
              onRename={rename}
              onForget={key => {
                closeTab(key)
                void run(api.forgetSession(key))
              }}
              onClose={() => setIsSessionsOpen(false)}
            />
          </PopHost>
          {tabs.length === 0 && (
            <button className="tool" onClick={() => newChat()} title="A blank Claude chat at the repo root">
              💬 New chat
            </button>
          )}
          {pins.length > 0 && <span className="divider" />}
          {pins.map(pin => {
            const terminal = terminalOf.get(pin.key)
            return (
              <button
                key={pin.key}
                className={`tool pin${terminal?.needsYou ? ' alert' : ''}`}
                title={`${pin.mode === 'fresh' ? 'Fresh run' : 'Keep chat'}: ${pin.prompt || 'no prompt'}`}
                onClick={async () => {
                  // A kept chat that is already open is just shown; a fresh run restarts, so ask first.
                  if (pin.mode === 'fresh' && terminal?.isAlive && !confirm(`Restart ${pin.label} with a fresh run?`)) {
                    openTab(pin.key)
                    return
                  }
                  if (pin.mode === 'fresh' || !terminal?.isAlive) await run(api.openPin(pin.key))
                  openTab(pin.key)
                }}
              >
                {terminal?.isAlive && <span className={`dot ${terminal.state}`} />}
                {pin.icon} {pin.label}
              </button>
            )
          })}
          <PopHost
            isOpen={isAddPinOpen}
            button={
              <button className="tool" onClick={() => setIsAddPinOpen(!isAddPinOpen)} title="Add a pinned chat">
                ＋ Pin
              </button>
            }
          >
            <AddPin onSaved={() => void run(api.snapshot())} onClose={() => setIsAddPinOpen(false)} />
          </PopHost>
          <div className="spacer" />
          <span className="count">
            {snap?.isRefreshing ? 'Refreshing…' : `Updated ${new Date(board.fetchedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`}
          </span>
        </div>

        <div className="board">
          {shown.map(lane => (
            <div
              key={lane.name}
              className={`lane ${lane.color}${dropOn === lane.name ? ' drop' : ''}`}
              onDragOver={event => {
                if (!lane.when) return
                event.preventDefault()
                setDropOn(lane.name)
              }}
              onDragLeave={() => setDropOn(undefined)}
              onDrop={event => {
                setDropOn(undefined)
                if (lane.when) moveTo(event.dataTransfer.getData('text/plain'), lane.when)
              }}
            >
              <div className="lane-head">
                <Tag color={lane.color}>{lane.name}</Tag>
                <span className="count">{lane.stories.length}</span>
                <div className="spacer" />
                <button className="tool" title="Hide this group" onClick={() => setHidden([...hidden, lane.name])}>
                  ⋯
                </button>
              </div>
              <div className="cards">
                {lane.stories.map(story => (
                  <Card
                    key={story.id}
                    rules={rules}
                    story={story}
                    hint={hints[story.id]}
                    isSelected={isShown(String(story.id))}
                    isStarred={prefs.pinned.includes(story.id)}
                    terminal={terminalOf.get(String(story.id))}
                    usage={snap?.usage[String(story.id)]}
                    showColumn={view === 'plan'}
                    draggable={view === 'plan'}
                    onOpen={() => openTab(String(story.id))}
                    onStar={() => star(story.id)}
                  />
                ))}
              </div>
            </div>
          ))}
          {tucked.length > 0 && (
            <div className="hidden-lane">
              <h4>Hidden groups</h4>
              {tucked.map(lane => (
                <button
                  key={lane.name}
                  className="hidden-row"
                  onClick={() => setHidden(hidden.filter(h => h !== lane.name))}
                >
                  <Tag color={lane.color}>{lane.name}</Tag>
                  <span className="count">{lane.stories.length}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      {tabs.length > 0 && (
        <>
          <div className="grip" onPointerDown={startGrip} />
          <aside className="side">
            <div className="layout-root">{layout && renderRoot(layout)}</div>
          </aside>
        </>
      )}
      {isSetupOpen && <Setup onClose={() => setIsSetupOpen(false)} />}
      {isTourOpen && <Tour steps={tourSteps(rules.workflow)} onClose={closeTour} />}
      {outputTask && <TaskOutput task={outputTask} onClose={() => setOutputTask(null)} />}
    </div>
  )
}

function TicketHead(props: {
  rules: Rules
  /** The project's sync-tasks command; empty hides the button. */
  syncCommand: string
  story: Story
  command: string
  why?: string
  isLive: boolean
  canResume: boolean
  onResume: () => void
  usage?: TokenUsage
  hasWorktree: boolean
  onStart: (prompt: string) => void
  onShell: () => void
  onStop: () => void
  onRemove: () => void
}) {
  const { rules, story, command, why, isLive } = props
  const lines = rules.drift(story)
  const threads = reviewThreads(story)

  return (
    <div className="ticket">
      <h2>{story.title}</h2>
      <div className="meta">
        <a href={story.url} target="_blank" rel="noreferrer">
          {story.id} ↗
        </a>
        <Tag color={rules.colorOf(story.column)}>{story.column}</Tag>
        {story.tier && <Tag color="gray">{story.tier}</Tag>}
        {threads > 0 && <Tag color="red">💬 {threads} review thread{threads === 1 ? '' : 's'}</Tag>}
      </div>
      {why && <p className="why">{why}</p>}
      {props.usage && (
        <p className="usage" title={usageTitle(props.usage)}>
          🪙 {compact(billed(props.usage))} tokens · {compact(props.usage.cacheRead)} cache reads · {props.usage.turns} requests
          {props.usage.today > 0 && ` · ${compact(props.usage.today)} today`}
        </p>
      )}
      {lines.length > 0 && <div className="drift">⚠ {lines.join(' · ')}</div>}
      <div className="actions">
        {isLive ? (
          <button className="tool" onClick={props.onStop}>
            ■ Stop terminal
          </button>
        ) : (
          <>
            {props.canResume && (
              <button className="tool" onClick={props.onResume} title="Reopen the conversation without sending anything">
                ⟳ Resume chat
              </button>
            )}
            <button className="tool primary" onClick={() => props.onStart(command)}>
              ▶ Claude: <code>{command}</code>
            </button>
          </>
        )}
        <button className="tool" onClick={props.onShell}>
          ⌨ Shell
        </button>
        {props.syncCommand && rules.hasTaskDrift(story) && !isLive && (
          <button className="tool" onClick={() => props.onStart(props.syncCommand.replaceAll('{id}', String(story.id)))}>
            ⟲ Sync stage tasks
          </button>
        )}
        {props.hasWorktree && (
          <button className="tool" onClick={props.onRemove}>
            🧹 Remove worktree
          </button>
        )}
      </div>
    </div>
  )
}

/** Open tabs grouped by where each ticket is in the process; the Planner first, a shell beside its ticket. */
function tabGroups(tabs: string[], stories: Map<string, Story>, pins: Pin[], rules: Rules) {
  const groups: { name: string; color: PillColor; keys: string[] }[] = []
  const add = (name: string, color: PillColor, key: string) => {
    const group = groups.find(g => g.name === name)
    if (group) group.keys.push(key)
    else groups.push({ name, color, keys: [key] })
  }
  const isPin = (key: string) => pins.some(p => p.key === key)
  for (const key of tabs.filter(isPin)) add('Pinned', 'yellow', key)
  for (const key of tabs.filter(isChatKey)) add('Chats', 'purple', key)
  for (const stage of rules.stageGroups) {
    for (const key of tabs) {
      const story = stories.get(key.replace(/-shell$/, ''))
      if (story && rules.stageGroup(story) === stage) add(stage, rules.stageColor(stage), key)
    }
  }
  // Tickets that left the board since their tab opened.
  for (const key of tabs) {
    if (!isPin(key) && !isChatKey(key) && !stories.has(key.replace(/-shell$/, ''))) add('Other', 'gray', key)
  }

  return groups
}

/** A toolbar button and its popover, which opens toward whichever side of the button has more room. */
function PopHost({ isOpen, button, children }: { isOpen: boolean; button: React.ReactNode; children: React.ReactNode }) {
  const host = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ side: 'left' | 'right'; room: number }>({ side: 'right', room: 640 })

  useLayoutEffect(() => {
    if (!isOpen || !host.current) return
    const at = host.current.getBoundingClientRect()
    const area = (host.current.closest('.main') ?? document.body).getBoundingClientRect()
    const toRight = area.right - at.left - 16
    const toLeft = at.right - area.left - 16
    setPlace(toRight >= toLeft ? { side: 'right', room: toRight } : { side: 'left', room: toLeft })
  }, [isOpen])

  return (
    <div
      ref={host}
      className={`pop-host opens-${place.side}`}
      style={{ '--room': `${Math.round(place.room)}px` } as React.CSSProperties}
    >
      {button}
      {isOpen && children}
    </div>
  )
}

/** The layout the single-project version kept: its split layout, or before that its open tabs. */
function legacyLayout(): LayoutNode | null {
  try {
    const split = localStorage.getItem('hq.layout')
    if (split) return JSON.parse(split) as LayoutNode
    const tabs = JSON.parse(localStorage.getItem('hq.tabs') ?? '[]') as string[]
    const active = JSON.parse(localStorage.getItem('hq.active') ?? 'null') as string | null
    return tabs.length > 0 ? emptyPane(tabs, active) : null
  } catch {
    return null
  }
}

/** The ▾ beside the title: every project, and a way to add one. */
function ProjectSwitcher(props: { current: string; name: string; projects: ProjectSummary[]; onSwitch: (id: string) => void; onNew: () => void }) {
  const [isOpen, setIsOpen] = useState(false)

  return (
    <div className="pop-host project-switch">
      <button className="tool" onClick={() => setIsOpen(!isOpen)} title="Switch project">
        📁 {props.name} ▾
      </button>
      {isOpen && (
        <div className="popover projects" onMouseLeave={() => setIsOpen(false)}>
          <h3>Projects</h3>
          {props.projects.map(p => (
            <button
              key={p.id}
              className={`inbox-row${p.id === props.current ? ' on' : ''}`}
              onClick={() => {
                setIsOpen(false)
                if (p.id !== props.current) props.onSwitch(p.id)
              }}
            >
              <span className="inbox-title">
                {p.id === props.current ? '● ' : ''}
                {p.name}
              </span>
              <span className="count">{p.tracker === 'github' ? 'GitHub' : 'Azure DevOps'}</span>
            </button>
          ))}
          <button
            className="tool primary"
            onClick={() => {
              setIsOpen(false)
              props.onNew()
            }}
          >
            ＋ New project
          </button>
        </div>
      )}
    </div>
  )
}

export function App() {
  const [project, setProjectState] = useState<string | null | undefined>(undefined)
  const [isNewOpen, setIsNewOpen] = useState(false)
  const [problem, setProblem] = useState<string>()

  const choose = useCallback((id: string) => {
    setProject(id)
    setProjectState(id)
    try {
      localStorage.setItem('hq.project', id)
    } catch {
      // Storage refused: the server remembers the active project anyway.
    }
    void api.setActiveProject(id).catch(() => undefined)
  }, [])

  useEffect(() => {
    api
      .projects()
      .then(({ active, projects }) => {
        let remembered: string | null = null
        try {
          remembered = localStorage.getItem('hq.project')
        } catch {
          remembered = null
        }
        const id = projects.some(p => p.id === remembered) ? remembered : active ?? projects[0]?.id ?? null
        if (id) {
          setProject(id)
          setProjectState(id)
        } else {
          setProjectState(null)
        }
      })
      .catch(caught => setProblem(caught instanceof Error ? caught.message : String(caught)))
  }, [])

  if (problem) return <div className="main"><div className="page-head"><p className="error">{problem}</p></div></div>
  if (project === undefined) return <div className="main"><div className="page-head"><p className="count">Loading…</p></div></div>
  if (project === null || isNewOpen) {
    return (
      <div className="main">
        <div className="page-head">
          <h1 className="page-title">{project === null ? 'Welcome to Sprinter' : 'New project'}</h1>
          <NewProjectForm
            onCreated={created => {
              setIsNewOpen(false)
              choose(created.id)
            }}
            onCancel={project === null ? undefined : () => setIsNewOpen(false)}
          />
        </div>
      </div>
    )
  }

  return <ProjectApp key={project} project={project} onSwitch={choose} onNew={() => setIsNewOpen(true)} />
}

const isChatKey = (key: string) => key.startsWith('chat-')

/** "💬 Chat 14:32": a blank chat is named by when it was started, which its key holds. */
function chatLabel(key: string) {
  const started = new Date(parseInt(key.slice(5), 36))
  return `💬 Chat ${Number.isNaN(started.getTime()) ? '' : started.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
}
