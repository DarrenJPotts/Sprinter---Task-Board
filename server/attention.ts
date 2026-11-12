import type { TerminalState } from '../shared/types.js'

// Claude Code's TUI repaints its spinner many times a second while it works,
// so a quiet stretch this long means it has stopped and is waiting.
export const QUIET_MS = 2500

// What Claude Code draws when it waits on you mid-turn: a permission dialog
// ("Do you want to proceed?", "❯ 1. Yes") or a question with options.
const ASKING = /Do you want to|Would you like to|❯\s*1\.|\(y\/n\)|\[y\/N\]|Esc to cancel|Enter to (select|confirm)/i

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** Terminal output as plain text: colour, cursor moves and titles removed. */
export const plain = (text: string) => text.replace(ANSI, '').replace(/\r/g, '')

export function terminalState(input: {
  isAlive: boolean
  isClaude: boolean
  now: number
  lastOutputAt: number
  lastInputAt: number
  tail: string
}): { state: TerminalState; needsYou: boolean } {
  if (!input.isAlive) return { state: 'exited', needsYou: false }
  if (input.now - input.lastOutputAt < QUIET_MS) return { state: 'working', needsYou: false }

  const screen = input.tail.slice(-1500)
  if (input.isClaude && ASKING.test(screen)) return { state: 'asking', needsYou: true }

  // Claude answered since you last typed and has gone quiet: its turn is over.
  const hasAnswered = input.lastOutputAt - input.lastInputAt > QUIET_MS

  return { state: 'idle', needsYou: input.isClaude && hasAnswered }
}
