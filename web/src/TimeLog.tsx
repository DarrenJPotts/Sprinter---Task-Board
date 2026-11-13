import { useState } from 'react'

import type { ChatTime, Task } from '../../shared/types'

const DONE = /^(closed|done|removed|resolved|completed)$/i
const HOUR = 3_600_000
const shown = (ms: number) => `${(ms / HOUR).toFixed(1)} h`

/** The task time most likely belongs to: the one in progress, else the first still open. */
const likelyTask = (tasks: Task[]) =>
  tasks.find(t => /active|progress|doing/i.test(t.state)) ?? tasks.find(t => !DONE.test(t.state)) ?? tasks[0]

/** A ticket chat's worked time, and a form that adds it to one of the story's tasks on the board. */
export function TimeLog(props: {
  time?: ChatTime
  tasks: Task[]
  /** Only an Azure DevOps board has a Completed Work field to log to. */
  canLog: boolean
  onLog: (taskId: number, hours: number) => Promise<unknown>
  onClear: () => Promise<unknown>
}) {
  const { time, tasks } = props
  const [isOpen, setIsOpen] = useState(false)
  const [taskId, setTaskId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [isBusy, setIsBusy] = useState(false)
  if (!time) return null

  const unlogged = time.unloggedMs
  // Rounded up to the quarter hour: ADO time is entered in hours, and a part-used quarter still counts.
  const suggested = Math.max(0.25, Math.ceil((unlogged / HOUR) * 4) / 4)
  const chosen = taskId ?? likelyTask(tasks)?.id ?? null
  const hours = Number(draft || suggested)
  const finish = (work: Promise<unknown>) => {
    setIsBusy(true)
    void work.finally(() => {
      setIsBusy(false)
      setIsOpen(false)
      setDraft('')
    })
  }

  return (
    <div className="time-log">
      <span className="usage" title="Time spent in this ticket's Claude chat. A pause of over 5 minutes counts as a break.">
        ⏱ {shown(time.activeMs)} in chat · {unlogged >= 60_000 ? `${shown(unlogged)} not logged` : 'all logged'}
      </span>
      {props.canLog && unlogged >= 60_000 && !isOpen && (
        <button className="tool" onClick={() => setIsOpen(true)}>
          Log time
        </button>
      )}
      {isOpen && (
        <div className="time-form">
          {tasks.length === 0 ? (
            <span className="count">This story has no tasks to log against.</span>
          ) : (
            <>
              <select value={chosen ?? ''} onChange={e => setTaskId(Number(e.target.value))}>
                {tasks.map(task => (
                  <option key={task.id} value={task.id}>
                    {task.title} · {task.state} · {task.completed} h done
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={0.25}
                max={24}
                step={0.25}
                value={draft || String(suggested)}
                onChange={e => setDraft(e.target.value)}
                aria-label="Hours"
              />
              <span className="count">h</span>
              <button
                className="tool primary"
                disabled={isBusy || chosen === null || !(hours > 0 && hours <= 24)}
                onClick={() => chosen !== null && finish(props.onLog(chosen, hours))}
              >
                Add to Completed Work
              </button>
            </>
          )}
          <button
            className="tool"
            disabled={isBusy}
            title="Count this time as logged without changing the board, e.g. when you logged it yourself"
            onClick={() => finish(props.onClear())}
          >
            Already logged
          </button>
          <button className="tool" disabled={isBusy} onClick={() => setIsOpen(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}
