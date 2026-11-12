import {
  COLUMN_COLOR,
  STAGE_GROUPS,
  STAGE_GROUP_COLOR,
  drift as aidlcDrift,
  hasTaskDrift as aidlcTaskDrift,
  nextCommand as aidlcNextCommand,
  stageGroup as aidlcStageGroup,
  whenOf as aidlcWhenOf,
} from './model.js'
import type { PillColor } from './model.js'
import type { PlanHint, Prefs, Story, When, Workflow } from './types.js'

/**
 * How a project's cards behave. AI-DLC knows its board columns, stage commands, stage-task
 * drift and gates; Plain knows only the tracker's own columns and one command template.
 */
export type Rules = {
  workflow: Workflow
  columns: string[]
  colorOf: (column: string) => PillColor
  nextCommand: (story: Story, hint?: PlanHint) => string
  drift: (story: Story) => string[]
  hasTaskDrift: (story: Story) => boolean
  /** Where a ticket is in the process, for grouping its terminal tabs. */
  stageGroup: (story: Story) => string
  stageGroups: string[]
  stageColor: (group: string) => PillColor
  whenOf: (story: Story, prefs: Prefs, hint?: PlanHint) => When
  isDone: (story: Story) => boolean
}

const PALETTE: PillColor[] = ['gray', 'brown', 'orange', 'yellow', 'blue', 'purple', 'pink', 'green', 'red']
const DONE = /^(done|closed|complete[d]?|released|shipped)$/i

export function makeRules(workflow: Workflow, columns: string[], commandTemplate: string): Rules {
  // A column's colour: AI-DLC's own where it names one, else by its place on the board.
  const colorOf = (column: string): PillColor => {
    if (workflow === 'aidlc' && COLUMN_COLOR[column]) return COLUMN_COLOR[column]!
    if (DONE.test(column)) return 'green'
    const at = columns.indexOf(column)
    return at < 0 ? 'gray' : PALETTE[at % PALETTE.length]!
  }
  const lastColumn = columns[columns.length - 1]
  const isDone = (story: Story) => DONE.test(story.column) || (workflow === 'plain' && story.column === lastColumn)

  if (workflow === 'aidlc') {
    return {
      workflow,
      columns,
      colorOf,
      nextCommand: aidlcNextCommand,
      drift: aidlcDrift,
      hasTaskDrift: aidlcTaskDrift,
      stageGroup: aidlcStageGroup,
      stageGroups: [...STAGE_GROUPS],
      stageColor: group => STAGE_GROUP_COLOR[group as keyof typeof STAGE_GROUP_COLOR] ?? 'gray',
      whenOf: aidlcWhenOf,
      isDone,
    }
  }

  return {
    workflow,
    columns,
    colorOf,
    nextCommand: story => commandTemplate.replaceAll('{id}', String(story.id)).replaceAll('{title}', story.title),
    drift: () => [],
    hasTaskDrift: () => false,
    stageGroup: story => story.column,
    stageGroups: columns,
    stageColor: colorOf,
    // Plain boards: first column waits, the last is done, anything between is under way.
    whenOf: (story, prefs) => {
      const saved = prefs.when[String(story.id)]
      if (saved) return saved
      if (story.isOffSprint || isDone(story)) return 'later'
      return story.column === columns[0] ? 'week' : 'today'
    },
    isDone,
  }
}
