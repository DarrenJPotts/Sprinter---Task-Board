import * as headless from '@xterm/headless'

import type { ChatPrompt } from '../shared/types.js'

// The package is CommonJS: under Node's ES modules its exports arrive as the default export.
const { Terminal: Headless } = (headless as { default?: typeof headless }).default ?? headless

/**
 * A copy of what a terminal shows, kept up to date from its output. Claude Code draws its questions with
 * cursor moves, so the raw output alone runs words together; this is the screen as a window draws it.
 */
export type Screen = InstanceType<typeof Headless>

export const newScreen = (cols: number, rows: number): Screen => new Headless({ cols, rows, scrollback: 0, allowProposedApi: true })

/** The visible rows, as text. */
export function screenLines(screen: Screen): string[] {
  const buffer = screen.buffer.active
  const lines: string[] = []
  for (let y = 0; y < screen.rows; y += 1) lines.push(buffer.getLine(buffer.viewportY + y)?.translateToString(true) ?? '')
  return lines
}

// The cursor row of one of Claude Code's choice lists ("❯ No, exit", "❯ 1. Yes"), inside a border or not.
const CURSOR = /^([\s│|]*)❯ (.*)$/
const RULE = /^[\s─━═╭╮╰╯┌┐└┘│|_-]*$/
// Footer and hint rows that are not part of the question.
const HINT = /^(Esc to|Enter to|↑|Tab to|ctrl\+|\? for shortcuts)/i
const NUMBER = /^\d{1,2}\.\s+/

/**
 * The choice Claude is waiting on, read off the screen: the rows lined up with the ❯ cursor (numbered or
 * not), which one the cursor is on, and the question above them. A row indented further than the options
 * is an option's description and is skipped.
 */
export function readPrompt(lines: string[]): ChatPrompt | undefined {
  const rows = lines.map(line => line.replace(/\s+$/, ''))
  let at = -1
  let indent = ''
  for (let y = rows.length - 1; y >= 0; y -= 1) {
    const match = CURSOR.exec(rows[y]!)
    if (match) {
      at = y
      indent = match[1]!
      break
    }
  }
  if (at < 0) return undefined

  // An option row: the same indent as the cursor, two spaces where the ❯ would be, then text.
  const column = indent.length + 2
  const optionAt = (y: number) => {
    const row = rows[y] ?? ''
    if (y === at) return CURSOR.exec(row)![2]!.trim()
    if (row.length <= column || row.slice(0, column).trim().replace(/[│|]/g, '') !== '' || row[column] === ' ') return null
    const text = row.slice(column).trim()
    return text && !HINT.test(text) ? text : null
  }
  const isDescription = (y: number) => {
    const row = rows[y] ?? ''
    return row.length > column && row.slice(0, column + 1).trim().replace(/[│|]/g, '') === '' && row.slice(column).trim() !== ''
  }

  // A description under an option, a blank line or a divider ("5. Chat about this" sits under one) can
  // come between options without ending the list.
  const isBetween = (y: number) => isDescription(y) || RULE.test(rows[y] ?? '')
  let first = at
  for (let y = at - 1; y >= 0; y -= 1) {
    if (optionAt(y) !== null) first = y
    else if (!isBetween(y)) break
  }
  let last = at
  for (let y = at + 1; y < rows.length; y += 1) {
    if (optionAt(y) !== null) last = y
    else if (!isBetween(y)) break
  }
  const options: string[] = []
  let selected = 0
  for (let y = first; y <= last; y += 1) {
    const text = optionAt(y)
    if (text === null) continue
    if (y === at) selected = options.length
    options.push(text.replace(NUMBER, ''))
  }
  if (options.length < 2) return undefined

  // The question: the nearest line above the options that asks something, else the nearest line of text.
  let question = ''
  for (let y = first - 1; y >= Math.max(0, first - 12); y -= 1) {
    const row = rows[y]!.replace(/^[\s│|]+|[\s│|]+$/g, '')
    if (!row || RULE.test(row) || HINT.test(row)) continue
    if (row.includes('?')) {
      question = row
      break
    }
    question ||= row
  }

  // "Type something." takes your own words: the cursor goes to it and what you type is the answer.
  const typed = options.findIndex(option => /^type something\b/i.test(option))

  return { question, options, selected, ...(typed >= 0 && { typed }) }
}
