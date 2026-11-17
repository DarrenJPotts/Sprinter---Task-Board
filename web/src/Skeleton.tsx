import type { OpeningPhase } from '../../shared/types'

export type StartPhase = OpeningPhase | 'booting'

const TEXT: Record<StartPhase, { title: string; detail: string }> = {
  queued: { title: 'Waiting its turn', detail: 'Another session is cutting its worktree first; git allows one at a time.' },
  worktree: { title: 'Creating the worktree', detail: 'Fetching the base branch and checking out a fresh copy. This can take a minute.' },
  starting: { title: 'Opening the terminal', detail: 'Starting the shell in its folder.' },
  booting: { title: 'Starting Claude', detail: 'Claude Code is loading the session.' },
}

// The placeholder terminal's rows; their widths vary in the stylesheet, so it reads as text, not a block.
const LINES = 10

/** A terminal-shaped placeholder while a session gets going, with what it is waiting on. */
export function TermSkeleton({ phase, onShow }: { phase: StartPhase; onShow?: () => void }) {
  const { title, detail } = TEXT[phase]
  return (
    <div className="term-skeleton" role="status" aria-live="polite">
      <div className="term-skeleton-head">
        <span className="spinner" aria-hidden="true" />
        <div>
          <strong>{title}…</strong>
          <p>{detail}</p>
        </div>
        {onShow && (
          <button className="tool" onClick={onShow} title="Hide this and show the terminal as it is">
            Show terminal
          </button>
        )}
      </div>
      <div className="term-skeleton-lines" aria-hidden="true">
        {Array.from({ length: LINES }, (_, i) => (
          <span key={i} className="bar" />
        ))}
      </div>
    </div>
  )
}
