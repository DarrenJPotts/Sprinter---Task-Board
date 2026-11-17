import { useState } from 'react'

import type { ChatTime, Story, Task } from '../../shared/types'

const DONE = /^(closed|done|removed|resolved|completed)$/i
const HOUR = 3_600_000
export const shown = (ms: number) => `${(ms / HOUR).toFixed(1)} h`
/** Less than a minute is not worth logging, so it never counts as owed. */
export const MIN_UNLOGGED = 60_000

// The stage task each board column's work belongs to, checked in order: "Spec Review" before "Spec".
const STAGES: [column: RegExp, task: RegExp][] = [
  [/spec review/i, /^spec review$/i],
  [/new|requirement|refine|ready for spec|spec/i, /^spec$/i],
  [/impl\w* review/i, /^implementation review$/i],
  [/dev test/i, /^dev testing$/i],
  [/impl/i, /^implementation$/i],
]
// QA and UAT tasks are the testers' to log, never a developer's chat time.
const TESTERS = /\b(qa|uat)\b/i

/**
 * The task time belongs to: the stage task for the story's board column, else the task in progress,
 * else the first open one that isn't QA or UAT.
 */
const likelyTask = (tasks: Task[], story?: Pick<Story, 'column' | 'state'>) => {
  const where = `${story?.column ?? ''} ${story?.state ?? ''}`
  const stage = STAGES.find(([column]) => column.test(where))
  const ours = tasks.filter(t => !TESTERS.test(t.title))
  return (
    (stage && ours.find(t => stage[1].test(t.title.trim()))) ??
    ours.find(t => /active|progress|doing/i.test(t.state)) ??
    ours.find(t => !DONE.test(t.state)) ??
    ours[0] ??
    tasks[0]
  )
}

// Rounded up to the quarter hour: ADO time is entered in hours, and a part-used quarter still counts.
const suggestedHours = (ms: number) => Math.max(0.25, Math.ceil((ms / HOUR) * 4) / 4)

/** A ticket chat's worked time, and a form that adds it to one of the story's tasks on the board. */
export function TimeLog(props: {
  time?: ChatTime
  tasks: Task[]
  story?: Pick<Story, 'column' | 'state'>
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
  const suggested = suggestedHours(unlogged)
  const chosen = taskId ?? likelyTask(tasks, props.story)?.id ?? null
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
        ⏱ {shown(time.activeMs)} in chat · {unlogged >= MIN_UNLOGGED ? `${shown(unlogged)} not logged` : 'all logged'}
      </span>
      {props.canLog && unlogged >= MIN_UNLOGGED && !isOpen && (
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

type Entry = { key: string; time: ChatTime; story?: Story }
type Plan = { taskId: number | null; hours: string }

/** Every ticket chat with time not yet logged, each with its own log form, or all logged in one go. */
export function TimeSheet(props: {
  entries: Entry[]
  canLog: boolean
  onLog: (key: string, taskId: number, hours: number) => Promise<unknown>
  onLogAll: (items: { key: string; taskId: number; hours: number }[]) => Promise<unknown>
  onClear: (key: string) => Promise<unknown>
  onOpen: (key: string) => void
}) {
  const total = props.entries.reduce((sum, entry) => sum + entry.time.unloggedMs, 0)
  const [plans, setPlans] = useState<Record<string, Plan> | null>(null)
  const [isBusy, setIsBusy] = useState(false)
  const planOf = (entry: Entry): Plan =>
    plans?.[entry.key] ?? { taskId: likelyTask(entry.story?.tasks ?? [], entry.story)?.id ?? null, hours: String(suggestedHours(entry.time.unloggedMs)) }
  const setPlan = (entry: Entry, change: Partial<Plan>) => setPlans({ ...plans, [entry.key]: { ...planOf(entry), ...change } })
  // A ticket with no task to log against (off the sprint, or no tasks yet) is left for you to log by hand.
  const items = props.entries
    .map(entry => ({ key: entry.key, taskId: planOf(entry).taskId, hours: Number(planOf(entry).hours) }))
    .filter((item): item is { key: string; taskId: number; hours: number } => item.taskId !== null)
  const isValid = items.length > 0 && items.every(item => item.hours > 0 && item.hours <= 24)
  const sum = items.reduce((hours, item) => hours + item.hours, 0)

  return (
    <div className="popover timesheet">
      <div className="timesheet-head">
        <h3>Unlogged time · {shown(total)}</h3>
        {props.canLog && props.entries.length > 0 && plans === null && (
          <button className="tool primary" onClick={() => setPlans({})} title="Log every ticket's time at once, after you check the tasks and hours">
            Log all
          </button>
        )}
      </div>
      {props.entries.length === 0 && <p className="count">All chat time is logged.</p>}
      {plans !== null ? (
        <>
          {props.entries.map(entry => {
            const plan = planOf(entry)
            const tasks = entry.story?.tasks ?? []
            return (
              <div key={entry.key} className="timesheet-row">
                <span className="timesheet-title">
                  <span className="count">AB#{entry.key}</span> {entry.story?.title ?? 'Not on this sprint'}
                </span>
                <div className="time-form">
                  {tasks.length === 0 ? (
                    <span className="count">No tasks to log against: {shown(entry.time.unloggedMs)} left unlogged.</span>
                  ) : (
                    <>
                      <select value={plan.taskId ?? ''} onChange={e => setPlan(entry, { taskId: Number(e.target.value) })} aria-label={`Task for ${entry.key}`}>
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
                        value={plan.hours}
                        onChange={e => setPlan(entry, { hours: e.target.value })}
                        aria-label={`Hours for ${entry.key}`}
                      />
                      <span className="count">h</span>
                    </>
                  )}
                </div>
              </div>
            )
          })}
          <div className="timesheet-foot">
            <button
              className="tool primary"
              disabled={isBusy || !isValid}
              onClick={() => {
                setIsBusy(true)
                void props.onLogAll(items).finally(() => {
                  setIsBusy(false)
                  setPlans(null)
                })
              }}
            >
              {isBusy ? 'Logging…' : `Add ${sum} h to Completed Work on ${items.length} ${items.length === 1 ? 'task' : 'tasks'}`}
            </button>
            <button className="tool" disabled={isBusy} onClick={() => setPlans(null)}>
              Cancel
            </button>
          </div>
        </>
      ) : (
        props.entries.map(({ key, time, story }) => (
          <div key={key} className="timesheet-row">
            <button className="timesheet-title" onClick={() => props.onOpen(key)} title="Open this ticket's chat">
              <span className="count">AB#{key}</span> {story?.title ?? 'Not on this sprint'}
            </button>
            <TimeLog
              time={time}
              tasks={story?.tasks ?? []}
              story={story}
              canLog={props.canLog}
              onLog={(taskId, hours) => props.onLog(key, taskId, hours)}
              onClear={() => props.onClear(key)}
            />
          </div>
        ))
      )}
    </div>
  )
}
