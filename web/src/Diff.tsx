import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import powershell from 'highlight.js/lib/languages/powershell'
import python from 'highlight.js/lib/languages/python'
import scss from 'highlight.js/lib/languages/scss'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'
import { useMemo, useState } from 'react'

import type { ChatItem, FileChange } from '../../shared/types'

type Tool = Extract<ChatItem, { kind: 'tool' }>
type Result = Extract<ChatItem, { kind: 'result' }>

// Only the languages these repos are written in, so the bundle stays small.
const LANGUAGES = { bash, csharp, css, javascript, json, markdown, powershell, python, scss, sql, typescript, xml, yaml }
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language)

const BY_EXTENSION: Record<string, keyof typeof LANGUAGES> = {
  ts: 'typescript', tsx: 'typescript', mts: 'typescript', cts: 'typescript',
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  cs: 'csharp', css: 'css', scss: 'scss', json: 'json', jsonc: 'json',
  md: 'markdown', yml: 'yaml', yaml: 'yaml', sql: 'sql', py: 'python',
  xml: 'xml', html: 'xml', svg: 'xml', csproj: 'xml', props: 'xml', targets: 'xml',
  sh: 'bash', ps1: 'powershell', psm1: 'powershell',
}

// How many rows a card shows before "Show all".
const PREVIEW = 40

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

/** One line of code as coloured HTML. Each line is coloured on its own, so a comment or string that spans lines may lose its colour; the text is always right. */
function paint(code: string, language: string | undefined): string {
  if (!language) return escape(code)
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value
  } catch {
    return escape(code)
  }
}

/** The file's name and the folder it sits in, counted from the worktree when it is in one. */
function pathParts(file: string): { name: string; folder: string } {
  const inTree = file.replace(/^.*[\\/]worktrees[\\/][^\\/]+[\\/]/, '')
  const parts = inTree.split(/[\\/]/)
  const name = parts.pop() ?? file
  // Outside a worktree the whole path is noise; the last few folders say where it is.
  const folders = inTree === file ? parts.slice(-3) : parts
  return { name, folder: folders.join('/') }
}

type Row =
  | { kind: 'gap'; text: string }
  | { kind: 'add' | 'del' | 'same'; old?: number; new?: number; html: string }

function rowsOf(change: FileChange): Row[] {
  const language = BY_EXTENSION[change.file.split('.').pop()?.toLowerCase() ?? '']
  const rows: Row[] = []
  change.hunks.forEach((hunk, i) => {
    if (i > 0 || hunk.oldStart > 1 || hunk.newStart > 1) rows.push({ kind: 'gap', text: hunk.newStart > 0 ? `line ${hunk.newStart}` : '' })
    let old = hunk.oldStart
    let next = hunk.newStart
    for (const line of hunk.lines) {
      const sign = line[0]
      const html = paint(line.slice(1), language)
      if (sign === '+') rows.push({ kind: 'add', new: next > 0 ? next++ : undefined, html })
      else if (sign === '-') rows.push({ kind: 'del', old: old > 0 ? old++ : undefined, html })
      else rows.push({ kind: 'same', old: old > 0 ? old++ : undefined, new: next > 0 ? next++ : undefined, html })
    }
  })
  // The first gap only marks where the edit starts; at the top of the file there is nothing to mark.
  if (rows[0]?.kind === 'gap' && !rows[0].text) rows.shift()
  return rows
}

const VERB: Record<FileChange['mode'], [doing: string, done: string]> = {
  create: ['Creating', 'Created'],
  rewrite: ['Writing', 'Wrote'],
  edit: ['Editing', 'Edited'],
}

/** A file change as a diff: what was taken out in red, what went in in green, with line numbers once the edit has run. */
export function ChangeCard({ tool, result }: { tool: Tool; result?: Result }) {
  // The result's copy has real line numbers and the lines around each change; until then, the request.
  const change = result?.change ?? tool.change!
  const [isOpen, setIsOpen] = useState(true)
  const [isAll, setIsAll] = useState(false)
  const rows = useMemo(() => rowsOf(change), [change])
  const added = rows.filter(row => row.kind === 'add').length
  const removed = rows.filter(row => row.kind === 'del').length
  const hasOld = rows.some(row => row.kind !== 'gap' && row.old !== undefined)
  const hasNew = rows.some(row => row.kind !== 'gap' && row.new !== undefined)
  const shown = isAll ? rows : rows.slice(0, PREVIEW)
  const { name, folder } = pathParts(change.file)
  const status = !result ? 'wait' : result.isError ? 'bad' : 'ok'
  const verb = VERB[change.mode][result ? 1 : 0]

  return (
    <div className={`chat-change ${change.mode}${isOpen ? ' open' : ''}`}>
      <button className="chat-change-head" onClick={() => setIsOpen(!isOpen)} title={change.file} aria-expanded={isOpen}>
        <span className="chat-caret">{isOpen ? '▾' : '▸'}</span>
        <span className={`chat-dot ${status}`} />
        <span className="chat-change-verb">{verb}</span>
        <strong className="chat-change-name">{name}</strong>
        {folder && <span className="chat-change-folder">{folder}</span>}
        <span className="chat-change-count">
          {added > 0 && <span className="add">+{added}</span>}
          {removed > 0 && <span className="del">−{removed}</span>}
        </span>
        {result?.isError && <span className="tag red">failed</span>}
      </button>
      {isOpen && (
        <>
          {result?.isError && <pre className="chat-result">{result.text}</pre>}
          <div className="diff">
            <table>
              <tbody>
                {shown.map((row, i) =>
                  row.kind === 'gap' ? (
                    <tr key={i} className="gap">
                      <td colSpan={(hasOld ? 1 : 0) + (hasNew ? 1 : 0) + 2}>⋯ {row.text}</td>
                    </tr>
                  ) : (
                    <tr key={i} className={row.kind}>
                      {hasOld && <td className="ln">{row.old}</td>}
                      {hasNew && <td className="ln">{row.new}</td>}
                      <td className="sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ''}</td>
                      <td className="code">
                        <code dangerouslySetInnerHTML={{ __html: row.html || ' ' }} />
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
          {(rows.length > PREVIEW || change.isClipped) && (
            <div className="diff-foot">
              {rows.length > PREVIEW && (
                <button className="tool" onClick={() => setIsAll(!isAll)}>
                  {isAll ? 'Show less' : `Show all ${rows.length} lines`}
                </button>
              )}
              {change.isClipped && isAll && <span>A long change: the rest is in the terminal.</span>}
            </div>
          )}
        </>
      )}
    </div>
  )
}
