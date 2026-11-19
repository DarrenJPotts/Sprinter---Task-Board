import { useState } from 'react'

import { PR_LANES, isReviewWaiting as isWaiting, prLane, prReason } from '../../shared/model'
import type { PillColor, PrLane } from '../../shared/model'
import type { Rules } from '../../shared/workflow'
import type { Checks, MyPr, PlanHint, ReviewPr, Story } from '../../shared/types'
import { Tag } from './Card'

// Done keeps two weeks of completed PRs; the latest few are enough to see what just landed.
const DONE_SHOWN = 6

const KIND: Record<MyPr['kind'], string> = { spec: 'Spec', impl: 'Impl', ship: 'Ship', other: '' }

const CHECKS: Record<Checks, { color: PillColor; text: string } | undefined> = {
  none: undefined,
  running: { color: 'yellow', text: '⏳ build running' },
  pass: { color: 'green', text: '✓ build passed' },
  fail: { color: 'red', text: '✗ build failed' },
}

/** How long ago, roughly: "just now", "5 h", "3 d". */
function since(iso: string | undefined, now: number): string {
  const at = iso ? Date.parse(iso) : NaN
  if (Number.isNaN(at)) return ''
  const hours = Math.floor((now - at) / 3_600_000)
  if (hours < 1) return 'just now'
  if (hours < 24) return `${hours} h`
  return `${Math.floor(hours / 24)} d`
}

/** Open lanes put the longest wait first; Done puts the latest first. */
function ordered(prs: MyPr[], lane: PrLane): MyPr[] {
  return lane === 'done'
    ? [...prs].sort((a, b) => (b.closedAt ?? '').localeCompare(a.closedAt ?? ''))
    : [...prs].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

type Props = {
  prs: MyPr[]
  stories: Map<string, Story>
  rules: Rules
  hints: Record<string, PlanHint>
  /** Work-item ids whose chat is open in a pane. */
  isShown: (key: string) => boolean
  /** Opens the story's tab, where its next command runs. */
  onOpenStory: (key: string) => void
  /** How the tracker writes an item id: AB#123 or #123. */
  refOf: (id: number) => string
  /** Other people's open PRs. */
  reviews: ReviewPr[]
  isReviewerUp: boolean
  /** Has the Reviewer draft a review of one PR, starting it first when it is not running. */
  onDraftReview: (id: number) => void
}

/** Your PRs by whose move it is (yours, a reviewer's, ready for a person to complete, or done), and other people's to review. */
export function PrBoard({ prs, stories, rules, hints, isShown, onOpenStory, refOf, reviews, isReviewerUp, onDraftReview }: Props) {
  const now = Date.now()
  const [isAllDone, setIsAllDone] = useState(false)
  return (
    <>
      {PR_LANES.map(({ lane, name, color }) => {
        const toReview =
          lane === 'theirs' ? (
            <ReviewLane key="review" reviews={reviews} isReviewerUp={isReviewerUp} now={now} onDraftReview={onDraftReview} />
          ) : null
        const all = ordered(
          prs.filter(pr => prLane(pr) === lane),
          lane,
        )
        const here = lane === 'done' && !isAllDone ? all.slice(0, DONE_SHOWN) : all
        // Reviewing is on you too, so it sits beside Your move, before the PRs that wait on others.
        return [
          toReview,
          <div key={lane} className={`lane ${color}`}>
            <div className="lane-head">
              <Tag color={color}>{name}</Tag>
              <span className="count">{all.length}</span>
            </div>
            <div className="cards">
              {here.length === 0 && <p className="lane-empty">{lane === 'mine' ? 'Nothing waiting on you.' : 'None.'}</p>}
              {here.map(pr => (
                <PrCard
                  key={pr.id}
                  pr={pr}
                  story={pr.storyId ? stories.get(String(pr.storyId)) : undefined}
                  rules={rules}
                  hint={pr.storyId ? hints[pr.storyId] : undefined}
                  isSelected={pr.storyId ? isShown(String(pr.storyId)) : false}
                  now={now}
                  onOpenStory={onOpenStory}
                  refOf={refOf}
                />
              ))}
              {all.length > DONE_SHOWN && lane === 'done' && (
                <button className="tool" onClick={() => setIsAllDone(!isAllDone)}>
                  {isAllDone ? 'Show fewer' : `Show all ${all.length}`}
                </button>
              )}
            </div>
          </div>,
        ]
      })}
    </>
  )
}

/** Other people's open PRs: the ones nobody has approved first, the longest wait first. */
function ReviewLane({ reviews, isReviewerUp, now, onDraftReview }: { reviews: ReviewPr[]; isReviewerUp: boolean; now: number; onDraftReview: (id: number) => void }) {
  const sorted = [...reviews].sort((a, b) => Number(isWaiting(b)) - Number(isWaiting(a)) || a.createdAt.localeCompare(b.createdAt))
  return (
    <div className="lane purple">
      <div className="lane-head">
        <Tag color="purple">To review</Tag>
        <span className="count" title="Waiting on a first approval, of all open">
          {reviews.filter(isWaiting).length} / {reviews.length}
        </span>
      </div>
      <div className="cards">
        {sorted.length === 0 && <p className="lane-empty">Nothing to review.</p>}
        {sorted.map(pr => {
          const open = () => window.open(pr.url, '_blank')
          const state = pr.isDraft
            ? 'Draft: not ready for review yet'
            : pr.changesAsked > 0
              ? 'Changes asked: waiting on its author'
              : pr.approvals > 0
                ? `${pr.approvals} approval${pr.approvals === 1 ? '' : 's'} already`
                : 'No approval yet'
          return (
            <div
              key={pr.id}
              className={`card pr-card review${isWaiting(pr) ? '' : ' quiet'}`}
              role="button"
              tabIndex={0}
              aria-label={`PR ${pr.id} ${pr.title}`}
              title="Open the PR"
              onClick={open}
              onKeyDown={event => {
                if (event.target !== event.currentTarget) return
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  open()
                }
              }}
            >
              <div className="card-actions" onClick={event => event.stopPropagation()}>
                <button
                  title={isReviewerUp ? 'Have the Reviewer draft a review of it; nothing is posted until you press Post' : 'Start the Reviewer: its first tick drafts every waiting review'}
                  onClick={() => onDraftReview(pr.id)}
                >
                  ✎
                </button>
              </div>
              <div className="card-title">
                <span className="card-ref">PR {pr.id}</span> {pr.title}
              </div>
              <div className="pr-reason">{state}</div>
              <div className="card-tags">
                {pr.isDraft && <Tag color="gray">draft</Tag>}
                {pr.approvals > 0 && <Tag color="green">✓ {pr.approvals} approved</Tag>}
                {pr.changesAsked > 0 && <Tag color="red">changes asked</Tag>}
              </div>
              <div className="card-foot">
                <span>{pr.author}</span>
                <span>·</span>
                <span>open {since(pr.createdAt, now)}</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

function PrCard(props: {
  pr: MyPr
  story?: Story
  rules: Rules
  hint?: PlanHint
  isSelected: boolean
  now: number
  onOpenStory: (key: string) => void
  refOf: (id: number) => string
}) {
  const { pr, story, rules, now } = props
  const lane = prLane(pr)
  const checks = CHECKS[pr.checks]
  // A story on your board opens its tab; any other PR opens in the tracker.
  const open = () => (story ? props.onOpenStory(String(story.id)) : window.open(pr.url, '_blank'))
  const age = lane === 'done' ? `completed ${since(pr.closedAt, now)} ago` : `open ${since(pr.createdAt, now)}`
  // Only where the move is yours is there a command to run; a reviewer's or a finished PR has none.
  const command = story && (lane === 'mine' || lane === 'ready') ? rules.nextCommand(story, props.hint).replace(` ${story.id}`, '') : ''

  return (
    <div
      className={`card pr-card ${lane}${props.isSelected ? ' on' : ''}`}
      role="button"
      tabIndex={0}
      aria-label={`PR ${pr.id} ${pr.title}`}
      title={story ? `Open ${props.refOf(story.id)}` : 'Open the PR'}
      onClick={open}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
    >
      <div className="card-actions" onClick={event => event.stopPropagation()}>
        <button title="Open the PR" onClick={() => window.open(pr.url, '_blank')}>
          ↗
        </button>
      </div>
      <div className="card-title">
        <span className="card-ref">PR {pr.id}</span> {pr.title}
      </div>
      <div className="pr-reason">{prReason(pr)}</div>
      <div className="card-tags">
        {KIND[pr.kind] && <Tag color="purple">{KIND[pr.kind]}</Tag>}
        {pr.target && (
          <span title={pr.target}>
            <Tag color="gray">→ {pr.target.replace(/^([\w-]+\/\d+)[-_].*$/, '$1')}</Tag>
          </span>
        )}
        {pr.storyId && (
          <span title={story?.title ?? 'Not on your board'}>
            <Tag color={story ? rules.colorOf(story.column) : 'gray'}>
              {props.refOf(pr.storyId)}
              {story ? ` · ${story.column}` : ''}
            </Tag>
          </span>
        )}
        {checks && lane !== 'done' && <Tag color={checks.color}>{checks.text}</Tag>}
        {pr.approvals > 0 && lane !== 'done' && <Tag color="green">✓ {pr.approvals} approved</Tag>}
      </div>
      <div className="card-foot">
        <span>{age}</span>
        {command && (
          <>
            <span>·</span>
            <span className="cmd">{command}</span>
          </>
        )}
      </div>
    </div>
  )
}
