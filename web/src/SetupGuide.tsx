import { useEffect, useState } from 'react'

import type { HealthCheck } from '../../shared/types'
import { api } from './api'

const SKILL_URL = 'https://github.com/DarrenJPotts/Sprinter---Task-Board/blob/main/skills/sprinter/SKILL.md'

/** A command with a button that copies it, for pasting into a terminal. */
function Command({ text }: { text: string }) {
  const [isCopied, setIsCopied] = useState(false)
  return (
    <span className="guide-command">
      <code>{text}</code>
      <button
        type="button"
        className="tool"
        onClick={() => {
          void navigator.clipboard?.writeText(text).then(() => {
            setIsCopied(true)
            setTimeout(() => setIsCopied(false), 1500)
          })
        }}
      >
        {isCopied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

/**
 * The first-run guide: what this machine needs (checked live), how to sign in, and what the project form
 * asks for. `children` is the project form, shown as the last step.
 */
export function SetupGuide({ children }: { children: React.ReactNode }) {
  const [checks, setChecks] = useState<HealthCheck[] | null>(null)
  const [error, setError] = useState('')
  const recheck = () => {
    setChecks(null)
    setError('')
    api
      .machine()
      .then(setChecks)
      .catch(caught => setError(caught instanceof Error ? caught.message : String(caught)))
  }
  useEffect(recheck, [])

  const missing = (checks ?? []).filter(c => !c.isOk && !c.isOptional)
  const hasTrackerTool = (checks ?? []).some(c => c.isOptional && c.isOk)

  return (
    <div className="guide">
      <p className="guide-intro">
        Sprinter shows your sprint as a board and gives every ticket its own Claude Code terminal, in its own git worktree. Four steps
        to get going; the first two happen once per machine.
      </p>

      <section className="guide-step">
        <h2>
          <span className="guide-n">1</span> Install the tools
          {checks && (missing.length === 0 ? <span className="tag green">ready</span> : <span className="tag red">{missing.length} missing</span>)}
          <button type="button" className="tool guide-recheck" onClick={recheck}>
            ⟳ Check again
          </button>
        </h2>
        {error && <p className="error">{error}</p>}
        <ul className="checks">
          {checks === null && !error && <li className="count">Checking this machine…</li>}
          {checks?.map(check => (
            <li key={check.name} className={check.isOk ? 'ok' : check.isOptional ? 'optional' : 'bad'}>
              <span className="mark">{check.isOk ? '✓' : check.isOptional ? '–' : '!'}</span>
              <div>
                <strong>{check.name}</strong>
                <div className="count">{check.isOk ? check.detail : check.isOptional ? 'Only needed for that kind of board.' : check.detail}</div>
                {!check.isOk && check.fix && <Command text={check.fix} />}
              </div>
            </li>
          ))}
        </ul>
        {checks && !hasTrackerTool && (
          <p className="count">Install the one for your board: the Azure CLI for Azure DevOps, or the GitHub CLI (or a GH_TOKEN) for GitHub.</p>
        )}
      </section>

      <section className="guide-step">
        <h2>
          <span className="guide-n">2</span> Sign in
        </h2>
        <ul className="guide-list">
          <li>
            <strong>Claude Code:</strong> open a terminal, run <code>claude</code> once and follow its sign-in. Every ticket terminal uses
            that account.
          </li>
          <li>
            <strong>Azure DevOps:</strong> <Command text="az login --tenant <your-tenant-id>" /> The tenant is the one your Azure DevOps
            organisation lives in.
          </li>
          <li>
            <strong>GitHub:</strong> <Command text="gh auth login" /> or set a <code>GH_TOKEN</code> environment variable before starting
            Sprinter.
          </li>
        </ul>
      </section>

      <section className="guide-step">
        <h2>
          <span className="guide-n">3</span> Add your first project
        </h2>
        <ul className="guide-list">
          <li>
            <strong>Repo folder:</strong> your local clone. Sprinter reads the board through the tracker and cuts each ticket's worktree
            from this repo.
          </li>
          <li>
            <strong>Worktrees cut from:</strong> the branch new ticket worktrees start from, usually <code>origin/main</code>.
          </li>
          <li>
            <strong>Workflow:</strong> Auto picks AI-DLC when the repo has an <code>ai-dlc.json</code>; otherwise each card sends one
            plain command.
          </li>
        </ul>
        {children}
      </section>

      <section className="guide-step">
        <h2>
          <span className="guide-n">4</span> Optional: let a chat start ticket sessions
        </h2>
        <p className="count">
          Copy the <a href={SKILL_URL} target="_blank" rel="noreferrer">sprinter skill</a> to <code>~/.claude/skills/sprinter/SKILL.md</code>.
          Then a chat inside Sprinter can, for example, "kick off all dev spec sessions": it lists the tickets, asks you, and opens a
          terminal for each.
        </p>
      </section>
    </div>
  )
}
