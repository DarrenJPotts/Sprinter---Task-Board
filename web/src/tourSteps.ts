import type { Workflow } from '../../shared/types'
import type { TourStep } from './Tour'
import { byText } from './Tour'

const first = (selector: string) => () => document.querySelector(selector)

/** The walk-through, in the order your eye meets the page: project, sprint, toolbar, board, panel. */
export function tourSteps(workflow: Workflow): TourStep[] {
  const isAidlc = workflow === 'aidlc'

  return [
    {
      title: 'Projects',
      body: 'Each project is one repo and its tracker, Azure DevOps or GitHub. Switch here, or add one with ＋ New project. Every project keeps its own board, pins and terminals.',
      target: first('.project-switch'),
    },
    {
      title: 'The sprint',
      body: 'Dates, working days left, and the load: the hours still on your open work against the hours you have left. Red means more work than time.',
      target: first('.props'),
    },
    {
      title: 'Board',
      body: "Your tickets in the tracker's own columns, read straight from the tracker. It costs no tokens and refreshes every five minutes.",
      target: byText('.views .view', 'Board'),
    },
    {
      title: 'Plan',
      body: 'The same tickets sorted into Today, This week, Next week and Parked. Drag a card between them; your moves and ★ stars are saved.',
      target: byText('.views .view', 'Plan'),
    },
    {
      title: 'Pinned chats',
      body: 'Standing Claude chats. A Fresh run starts a new conversation with its prompt every press; Keep chat reopens the same conversation. ＋ Pin adds one.',
      target: first('.tool.pin'),
    },
    {
      title: 'Tokens today',
      body: "What today's ticket sessions used, and all of them together, read from Claude's own transcripts. Cache reads are left out: they cost a tenth as much.",
      target: byText('.props .prop-name', 'Tokens'),
    },
    {
      title: 'Reviews',
      body: "Other people's open PRs, oldest first. Start the Reviewer to draft reviews; nothing is posted until you press Post.",
      target: byText('.views .tool', 'Reviews'),
    },
    {
      title: 'Needs you',
      body: 'Every Claude that is asking you something or has finished its turn, plus PRs with review threads to answer. The count also shows in the window title.',
      target: byText('.views .tool', 'Needs you'),
    },
    {
      title: 'A ticket',
      body: isAidlc
        ? 'Its tier, points, hours, PRs and any board drift, with the next stage command at the bottom. Click it to open its own Claude terminal on the right.'
        : 'Its labels, points and PRs, with the command its Claude will run at the bottom. Click it to open its own Claude terminal on the right.',
      target: first('.card'),
    },
    {
      title: 'Columns',
      body: '⋯ hides a column you do not need; hidden ones wait at the end of the board under Hidden groups.',
      target: first('.lane-head .tool'),
    },
    {
      title: 'Terminal tabs',
      body: 'Each ticket gets its own git worktree and Claude session, resumed where it left off. Drag a tab to the edge of a pane to split it, or onto another pane to move it.',
      target: first('.side .tab'),
    },
    {
      title: 'Start or resume',
      body: '▶ Claude runs the card\'s command in its terminal; ⟳ Resume chat reopens the conversation without sending anything; ⌨ Shell opens a plain shell in the same worktree.',
      target: first('.ticket .actions'),
    },
    {
      title: 'Debug, Setup and colours',
      body: '🐞 lists recent errors. ⚙ Setup checks your machine and holds the project settings and pins. The last button cycles light, dark and auto. Press ? Tour to see this again.',
      target: first('.head-tools'),
    },
  ]
}
