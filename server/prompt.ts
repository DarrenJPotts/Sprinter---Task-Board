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
const HINT = /^(Esc to|Enter to|↑|Tab to|ctrl\+|\? for shortcuts|Notes:)/i
const NUMBER = /^\d{1,2}\.\s+/
// A box drawn beside the list (AskUserQuestion's preview of the highlighted option): a corner running into
// its edge, which no label has, or a side after a gap. A label as long as its column leaves no gap.
const BESIDE = /(\s*[┌╭└╰├]─|\s{2,}[│┃]).*$/
// The tab row of a multi-question form ("☐ D4 Endings", "☒ D3 Scope  ✔ Submit").
const TABS = /[☐☒☑✔✓]\s*\S/
const BOX_TOP = /[┌╭]/
const BOX_SIDE = /[│┃]/

// A list item's first row in a question: the rows under it are its wrapped text.
const ITEM = /^([-*•]|\d{1,2}[.)])\s/

/** A question's rows as text: wrapped rows rejoined, blank rows kept as paragraph breaks, items on their own lines. */
function reflow(lines: string[]): string {
  let text = ''
  let isBlank = false
  for (const line of lines) {
    if (!line) {
      isBlank = text !== ''
      continue
    }
    text += !text ? line : isBlank ? `\n\n${line}` : ITEM.test(line) ? `\n${line}` : ` ${line}`
    isBlank = false
  }
  return text
}

const clip = (text: string) => text.replace(BESIDE, '').trim()
const unbordered = (row: string) => row.replace(/^[\s│|]+|[\s│|]+$/g, '')

/** The text inside the box whose top-left corner is at column `x` of row `top`, its indent kept. */
function boxText(rows: string[], top: number, x: number): string {
  const inner: string[] = []
  for (let y = top + 1; y < rows.length; y += 1) {
    const edge = rows[y]![x]
    if (!edge || !BOX_SIDE.test(edge)) break
    inner.push(rows[y]!.slice(x + 1).replace(/[│┃]\s*$/, '').trimEnd())
  }
  while (inner.length > 0 && !inner.at(-1)!.trim()) inner.pop()
  while (inner.length > 0 && !inner[0]!.trim()) inner.shift()
  const indent = Math.min(...inner.filter(line => line.trim()).map(line => /^ */.exec(line)![0].length))
  return inner.map(line => line.slice(indent)).join('\n')
}

/**
 * The choice Claude is waiting on, read off the screen: the rows lined up with the ❯ cursor (numbered or
 * not), which one the cursor is on, and the question above them. A row indented further than the options
 * is an option's description, or, when a preview box sits beside the list, the rest of a wrapped label.
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

  // An option row: the cursor's indent exactly (a border only where the cursor row has one, or a boxed
  // question above an unboxed list reads as options), two spaces where the ❯ would be, then text.
  const column = indent.length + 2
  const edge = (text: string) => text.replace(/[│|]/g, '|')
  const isLinedUp = (row: string, spaces: number) =>
    edge(row.slice(0, indent.length)) === edge(indent) && row.slice(indent.length, column + spaces).trim() === ''
  // In a numbered list every option has its number; a row without one is not an option.
  const isNumbered = NUMBER.test(clip(CURSOR.exec(rows[at]!)![2]!))
  const optionAt = (y: number) => {
    const row = rows[y] ?? ''
    if (y === at) return clip(CURSOR.exec(row)![2]!)
    if (row.length <= column || !isLinedUp(row, 0) || row[column] === ' ') return null
    const text = clip(row.slice(column))
    if (!text || HINT.test(text)) return null
    return isNumbered && !NUMBER.test(text) ? null : text
  }
  const descriptionAt = (y: number) => {
    const row = rows[y] ?? ''
    if (row.length <= column || !isLinedUp(row, 1)) return ''
    const text = clip(row.slice(column))
    return HINT.test(text) ? '' : text
  }
  const isDescription = (y: number) => descriptionAt(y) !== ''

  // A description under an option, a blank line or a divider ("5. Chat about this" sits under one) can
  // come between options without ending the list.
  const isBetween = (y: number) => isDescription(y) || RULE.test(rows[y] ?? '')
  let first = at
  for (let y = at - 1; y >= 0; y -= 1) {
    if (optionAt(y) !== null) first = y
    else if (!isBetween(y)) break
  }
  // In a narrow terminal the preview box sits under the list instead of beside it; it ends the list, or its
  // rows would read as options.
  let below = -1
  let last = at
  for (let y = at + 1; y < rows.length; y += 1) {
    if (/^\s*[┌╭]─/.test(rows[y]!)) {
      below = y
      break
    }
    if (optionAt(y) !== null) last = y
    else if (!isBetween(y)) break
  }
  // The highlighted option's preview: a box beside the list (its top level with the first option or just
  // above it) or under it. A label too long for the list's column wraps onto the next row then.
  let preview: string | undefined
  for (let y = Math.max(0, first - 1); y <= first + 1 && !preview; y += 1) {
    const x = (rows[y] ?? '').search(BOX_TOP)
    if (x > column + 2) preview = boxText(rows, y, x) || undefined
  }
  if (!preview && below >= 0) preview = boxText(rows, below, rows[below]!.search(BOX_TOP)) || undefined

  const options: string[] = []
  const details: string[] = []
  let selected = 0
  for (let y = first; y <= last; y += 1) {
    const text = optionAt(y)
    if (text !== null) {
      if (y === at) selected = options.length
      options.push(text.replace(NUMBER, ''))
      details.push('')
      continue
    }
    const more = descriptionAt(y)
    if (!more || options.length === 0) continue
    const i = options.length - 1
    if (preview) options[i] = `${options[i]} ${more}`
    else details[i] = details[i] ? `${details[i]} ${more}` : more
  }
  if (options.length < 2) return undefined

  // The question: the paragraph above the options that asks something (else the nearest one), its lines
  // joined. A paragraph is the run of rows at one indent, so a dialog's indented detail stays out of it.
  const isText = (y: number) => {
    const row = unbordered(rows[y] ?? '')
    return Boolean(row) && !RULE.test(row) && !HINT.test(row) && !TABS.test(row)
  }
  const indentOf = (y: number) => /^[\s│|]*/.exec(rows[y] ?? '')![0].length
  let ask = -1
  let nearest = -1
  for (let y = first - 1; y >= Math.max(0, first - 14); y -= 1) {
    if (!isText(y)) continue
    if (nearest < 0) nearest = y
    if (rows[y]!.includes('?')) {
      ask = y
      break
    }
  }
  const anchor = ask >= 0 ? ask : nearest
  let question = ''
  // A question drawn in a box (AskUserQuestion's, with │ down its left edge) is the box's whole text.
  const isBoxed = (y: number) => /^[│┃]/.test(rows[y] ?? '') && !/^[│┃]\s{0,2}[❯]/.test(rows[y] ?? '')
  if (anchor >= 0 && isBoxed(anchor) && !isBoxed(at)) {
    let top = anchor
    let bottom = anchor
    while (top > 0 && isBoxed(top - 1)) top -= 1
    while (bottom < first - 1 && isBoxed(bottom + 1)) bottom += 1
    question = reflow(rows.slice(top, bottom + 1).filter(row => !TABS.test(row)).map(unbordered))
  } else if (anchor >= 0) {
    let top = anchor
    let bottom = anchor
    while (top > 0 && isText(top - 1) && indentOf(top - 1) === indentOf(anchor)) top -= 1
    while (bottom < first - 1 && isText(bottom + 1) && indentOf(bottom + 1) === indentOf(anchor)) bottom += 1
    question = rows
      .slice(top, bottom + 1)
      .map(unbordered)
      .join(' ')
  }

  // The form's tab row, above the question: which question of several this is.
  let header: string | undefined
  for (let y = (anchor >= 0 ? anchor : first) - 1; y >= Math.max(0, first - 16); y -= 1) {
    if (TABS.test(rows[y] ?? '')) {
      header = unbordered(rows[y]!).replace(/^←\s*|\s*→$/g, '').replace(/\s{2,}/g, '   ')
      break
    }
  }

  // "Type something." takes your own words: the cursor goes to it and what you type is the answer.
  const typed = options.findIndex(option => /^type something\b/i.test(option))

  return {
    question,
    options,
    selected,
    ...(typed >= 0 && { typed }),
    ...(details.some(Boolean) && { details }),
    ...(preview && { preview }),
    ...(header && { header }),
  }
}
