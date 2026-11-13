import { TIER_COLOR, remainingHours, reviewThreads } from '../../shared/model'
import type { PillColor } from '../../shared/model'
import type { Rules } from '../../shared/workflow'
import type { PlanHint, Story, TerminalInfo, TokenUsage } from '../../shared/types'
import { billed, compact, usageTitle } from './tokens'

/** How the tracker writes an item's id: AB#123 on Azure DevOps, #123 on GitHub. */
export const itemRef = (story: Story) => (/github.com/.test(story.url) ? `#${story.id}` : `AB#${story.id}`)

export function Tag({ color, children }: { color: PillColor; children: React.ReactNode }) {
  return <span className={`tag ${color}`}>{children}</span>
}

type Props = {
  rules: Rules
  story: Story
  hint?: PlanHint
  isSelected: boolean
  isStarred: boolean
  terminal?: TerminalInfo
  usage?: TokenUsage
  showColumn: boolean
  onOpen: () => void
  onStar: () => void
  draggable?: boolean
}

export function Card({ rules, story, hint, isSelected, isStarred, terminal, usage, showColumn, onOpen, onStar, draggable }: Props) {
  const hours = remainingHours(story)
  const drifted = rules.drift(story).length
  const threads = reviewThreads(story)
  const isLive = terminal?.isAlive === true

  return (
    <div
      className={`card${isSelected ? ' on' : ''}`}
      onClick={onOpen}
      draggable={draggable}
      onDragStart={event => event.dataTransfer.setData('text/plain', String(story.id))}
    >
      <div className="card-actions" onClick={event => event.stopPropagation()}>
        <button title={isStarred ? 'Unstar' : 'Star'} onClick={onStar}>
          {isStarred ? '★' : '☆'}
        </button>
        <button title="Open in Azure DevOps" onClick={() => window.open(story.url, '_blank')}>
          ↗
        </button>
      </div>
      <div className="card-title">
        {isStarred && '★ '}
        {story.type === 'Bug' && '🐞 '}
        <span className="card-ref">{itemRef(story)}</span> {story.title}
      </div>
      <div className="card-tags">
        {showColumn && <Tag color={rules.colorOf(story.column)}>{story.column}</Tag>}
        {story.tier && <Tag color={TIER_COLOR[story.tier] ?? 'gray'}>{story.tier}</Tag>}
        {story.points !== undefined && <Tag color="gray">{story.points} pts</Tag>}
        {hours > 0 && <Tag color="blue">{hours} h</Tag>}
        {story.prs.map(pr => (
          <Tag key={pr.id} color={pr.isCompleted ? 'green' : pr.vote < 0 ? 'red' : pr.vote > 0 ? 'green' : 'purple'}>
            PR {pr.id}
            {pr.isCompleted ? ' · merged' : pr.isDraft ? ' · draft' : pr.vote < 0 ? ' · changes asked' : pr.vote > 0 ? ' · approved' : ''}
          </Tag>
        ))}
        {story.isOffSprint && <Tag color="gray">off-sprint</Tag>}
        {drifted > 0 && <Tag color="orange">⚠ {drifted} drift</Tag>}
        {threads > 0 && <Tag color="red">💬 {threads} to answer</Tag>}
        {terminal?.state === 'asking' && <Tag color="pink">? Asking you</Tag>}
        {terminal?.state === 'idle' && terminal.needsYou && <Tag color="yellow">● Your turn</Tag>}
        {terminal?.state === 'working' && <Tag color="green">⏳ Working</Tag>}
        {usage && (
          <span title={usageTitle(usage)}>
            <Tag color="gray">🪙 {compact(billed(usage))}</Tag>
          </span>
        )}
      </div>
      <div className="card-foot">
        {isLive && <span className="dot" title="Terminal running" />}
        <span>{story.id}</span>
        <span>·</span>
        <span className="cmd">{rules.nextCommand(story, hint).replace(` ${story.id}`, '')}</span>
      </div>
    </div>
  )
}
