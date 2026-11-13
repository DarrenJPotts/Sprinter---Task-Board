import { useEffect, useState } from 'react'

import type { BgTask, SessionInfo, TerminalInfo } from '../../shared/types'
import { api } from './api'
import { ask } from './Dialog'
import { compact } from './tokens'

const ago = (iso?: string) => {
  if (!iso) return ''
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`
}

const STATUS_COLOR: Record<string, string> = { running: 'yellow', completed: 'green', failed: 'red', killed: 'gray', stopped: 'gray' }

/** Background shell commands and agents the chats started, grouped by chat, running ones first. */
export function Tasks(props: {
  tasks: Record<string, BgTask[]>
  label: (key: string) => string
  onOpen: (key: string) => void
  onShowOutput: (task: BgTask) => void
  onClose: () => void
}) {
  const keys = Object.keys(props.tasks).sort((a, b) => {
    const running = (key: string) => props.tasks[key]!.some(t => t.status === 'running')
    return Number(running(b)) - Number(running(a))
  })

  return (
    <div className="popover tasks">
      <div className="modal-head">
        <h3>Background tasks</h3>
        <button className="tool" onClick={props.onClose}>
          ✕
        </button>
      </div>
      {keys.length === 0 && <p className="count">No chat has started a background task.</p>}
      {keys.map(key => (
        <div key={key} className="task-group">
          <button className="task-owner" onClick={() => props.onOpen(key)} title="Open this chat">
            {props.label(key)} ↗
          </button>
          {props.tasks[key]!.slice(0, 12).map(task => (
            <TaskRow key={task.id} task={task} onShowOutput={props.onShowOutput} />
          ))}
        </div>
      ))}
    </div>
  )
}

function TaskRow({ task, onShowOutput }: { task: BgTask; onShowOutput: (task: BgTask) => void }) {
  return (
    <div className="task-row">
      <span className={`tag ${STATUS_COLOR[task.status] ?? 'gray'}`}>{task.status}</span>
      <span className="task-kind" title={task.kind === 'agent' ? 'Agent' : 'Shell command'}>
        {task.kind === 'agent' ? '🤖' : '⚙'}
      </span>
      <div className="task-text">
        <div>{task.description}</div>
        <div className="count">
          {ago(task.startedAt)}
          {task.summary ? ` · ${task.summary}` : ''}
        </div>
      </div>
      {task.outputFile && (
        <button className="tool" onClick={() => onShowOutput(task)}>
          Output
        </button>
      )}
    </div>
  )
}

/** The floating button over one terminal: that chat's own background tasks, opening upward. */
export function PaneTasks({ tasks, onShowOutput, isInline }: { tasks: BgTask[]; onShowOutput: (task: BgTask) => void; isInline?: boolean }) {
  const [isOpen, setIsOpen] = useState(false)
  const running = tasks.filter(t => t.status === 'running').length
  const sorted = [...tasks].sort((a, b) => Number(b.status === 'running') - Number(a.status === 'running'))

  return (
    <div className={`pane-tasks${isInline ? ' inline' : ''}`}>
      {isOpen && (
        <div className="pane-tasks-list">
          <div className="modal-head">
            <h3>This chat's tasks</h3>
            <button className="tool" onClick={() => setIsOpen(false)}>
              ✕
            </button>
          </div>
          {sorted.slice(0, 12).map(task => (
            <TaskRow key={task.id} task={task} onShowOutput={onShowOutput} />
          ))}
        </div>
      )}
      <button
        className={`tool pane-tasks-button${running ? ' primary' : ''}`}
        onClick={() => setIsOpen(!isOpen)}
        title="Background shell commands and agents this chat started"
      >
        🧵 Tasks
        <span className="badge">{running ? `${running} running` : tasks.length}</span>
      </button>
    </div>
  )
}

/** A background task's output file, tailed while it runs. */
export function TaskOutput({ task, onClose }: { task: BgTask; onClose: () => void }) {
  const [text, setText] = useState('Reading…')
  const [note, setNote] = useState('')

  useEffect(() => {
    const load = () =>
      api
        .taskOutput(task.outputFile!)
        .then(out => {
          setText(out.text || '(no output yet)')
          setNote(out.isCut ? `Last 64 KB of ${compact(out.size)} bytes` : '')
        })
        .catch(caught => setText(caught instanceof Error ? caught.message : String(caught)))
    load()
    const timer = task.status === 'running' ? setInterval(load, 3_000) : undefined
    return () => clearInterval(timer)
  }, [task])

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal output" onClick={event => event.stopPropagation()}>
        <div className="modal-head">
          <h3>{task.description}</h3>
          <span className={`tag ${STATUS_COLOR[task.status] ?? 'gray'}`}>{task.status}</span>
          <button className="tool" onClick={onClose}>
            ✕
          </button>
        </div>
        {note && <p className="count">{note}</p>}
        <pre className="output-text">{text}</pre>
      </div>
    </div>
  )
}

/** Every saved Claude session of the project: open it, rename it, or forget it. */
export function Sessions(props: {
  sessions: SessionInfo[]
  terminals: TerminalInfo[]
  label: (key: string) => string
  onOpen: (key: string) => void
  onRename: (key: string, name: string) => void
  onForget: (key: string) => void
  onClose: () => void
}) {
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const running = new Set(props.terminals.filter(t => t.isAlive).map(t => t.key))
  const sorted = [...props.sessions].sort((a, b) => (b.lastAt ?? '').localeCompare(a.lastAt ?? ''))

  return (
    <div className="popover sessions">
      <div className="modal-head">
        <h3>Saved sessions</h3>
        <button className="tool" onClick={props.onClose}>
          ✕
        </button>
      </div>
      {sorted.length === 0 && <p className="count">No Claude session has been started in this project yet.</p>}
      {sorted.map(session => (
        <div key={session.key} className="session-row">
          <div className="session-main">
            {editing === session.key ? (
              <input
                autoFocus
                className="rename"
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onBlur={() => setEditing(null)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    props.onRename(session.key, draft)
                    setEditing(null)
                  }
                  if (e.key === 'Escape') setEditing(null)
                }}
              />
            ) : (
              <strong>{props.label(session.key)}</strong>
            )}
            <div className="count">
              {running.has(session.key) ? '● running · ' : ''}
              {session.hasTranscript ? `last active ${ago(session.lastAt) || 'unknown'}` : 'no conversation saved yet'}
              {session.tokens ? ` · 🪙 ${compact(session.tokens)}` : ''}
            </div>
          </div>
          <div className="session-actions">
            <button className="tool" onClick={() => props.onOpen(session.key)}>
              Open
            </button>
            <button
              className="tool"
              title="Rename"
              onClick={() => {
                setDraft(props.label(session.key).replace(/^💬 /, ''))
                setEditing(session.key)
              }}
            >
              ✎
            </button>
            <button
              className="tool"
              title="Forget: stop it and drop it from this list (Claude keeps the transcript)"
              onClick={async () =>
                (await ask({
                  title: `Forget ${props.label(session.key)}?`,
                  body: 'Its terminal stops and it leaves this list. Claude keeps the conversation, so nothing is lost.',
                  confirm: 'Forget',
                  isDanger: true,
                })) && props.onForget(session.key)
              }
            >
              🗑
            </button>
          </div>
        </div>
      ))}
    </div>
  )
}
