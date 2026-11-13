import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { ChatItem, ChatPage, TerminalState } from '../../shared/types'
import { projectId } from './api'

type Tool = Extract<ChatItem, { kind: 'tool' }>
type Result = Extract<ChatItem, { kind: 'result' }>
type Entry =
  | Exclude<ChatItem, Tool | Result>
  | { kind: 'steps'; id: string; tools: Tool[] }

// How many entries are drawn at first, and how many more each "Show earlier" adds.
const PAGE = 80

type Cached = { items: ChatItem[]; next: number; isCut: boolean; hasTranscript: boolean }
// Each chat's conversation stays in memory while the app is open, so coming back to it is instant and
// only what is new is read.
const cache = new Map<string, Cached>()

// Transcripts carry text from PRs, files and web pages: it is rendered as markdown but never trusted as HTML.
const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false })), [text])
  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
})

/** Tool calls in a row fold into one line; the results are matched to their calls by id. */
function entriesOf(items: ChatItem[]): Entry[] {
  const out: Entry[] = []
  for (const item of items) {
    if (item.kind === 'result') continue
    if (item.kind === 'tool') {
      const last = out.at(-1)
      if (last?.kind === 'steps') last.tools.push(item)
      else out.push({ kind: 'steps', id: `steps-${item.id}`, tools: [item] })
      continue
    }
    out.push(item)
  }
  return out
}

function Steps({ tools, results }: { tools: Tool[]; results: Map<string, Result> }) {
  const [isOpen, setIsOpen] = useState(false)
  const [shown, setShown] = useState<string | null>(null)
  const last = tools.at(-1)!
  const failed = tools.filter(t => results.get(t.id)?.isError).length
  const names = [...new Set(tools.map(t => t.name.replace(/^mcp__[^_]+__/, '')))].slice(0, 4).join(', ')

  return (
    <div className={`chat-steps${isOpen ? ' open' : ''}`}>
      <button className="chat-steps-head" onClick={() => setIsOpen(!isOpen)}>
        <span className="chat-caret">{isOpen ? '▾' : '▸'}</span>
        {tools.length === 1 ? (
          <span>
            <strong>{last.name.replace(/^mcp__[^_]+__/, '')}</strong> {last.summary}
          </span>
        ) : (
          <span>
            <strong>{tools.length} steps</strong> · {names}
            {!isOpen && last.summary ? ` · last: ${last.summary}` : ''}
          </span>
        )}
        {failed > 0 && <span className="tag red">{failed} failed</span>}
      </button>
      {isOpen &&
        tools.map(tool => {
          const result = results.get(tool.id)
          return (
            <div key={tool.id} className="chat-step">
              <button className="chat-step-line" onClick={() => setShown(shown === tool.id ? null : tool.id)} title="Show what it returned">
                <span className={`chat-dot${result ? (result.isError ? ' bad' : ' ok') : ' wait'}`} />
                <strong>{tool.name.replace(/^mcp__[^_]+__/, '')}</strong>
                {tool.isBackground && <span className="tag yellow">background</span>}
                <span className="chat-step-summary">{tool.summary}</span>
              </button>
              {shown === tool.id && <pre className="chat-result">{result?.text || (result ? '(no output)' : 'Still running…')}</pre>}
            </div>
          )
        })}
    </div>
  )
}

type Composer = {
  /** The chat's terminal is running, so there is something to type into. */
  isLive: boolean
  state?: TerminalState
  onSend: (text: string) => Promise<unknown>
  onEscape: () => void
  /** Present when the chat can be resumed. */
  onResume?: () => void
  onShowTerminal: () => void
  /** Sits beside the send button: the pane's Tasks button. */
  tools?: ReactNode
}

/** The box under the conversation: what is typed goes to the chat's terminal, as if typed there. */
function Composer({ termKey, isLive, state, onSend, onEscape, onResume, onShowTerminal, tools, onSent }: Composer & { termKey: string; onSent: () => void }) {
  const [draft, setDraft] = useState('')
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  // A question on screen (a permission prompt, a choice) reads keys, not a message: typing into it could pick an option.
  const isAsking = state === 'asking'

  useEffect(() => {
    setDraft('')
    setError('')
  }, [termKey])

  // The box grows with what is typed, up to a limit, then scrolls.
  useLayoutEffect(() => {
    const el = input.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [draft])

  const send = async () => {
    const text = draft.trim()
    if (!text || isSending || !isLive || isAsking) return
    setIsSending(true)
    setError('')
    try {
      await onSend(text)
      setDraft('')
      onSent()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIsSending(false)
      input.current?.focus()
    }
  }

  if (!isLive)
    return (
      <div className="chat-composer idle">
        <span>This chat is not running.</span>
        {onResume && (
          <button className="tool primary" onClick={onResume}>
            ⟳ Resume chat
          </button>
        )}
        <div className="spacer" />
        {tools}
      </div>
    )

  return (
    <div className="chat-composer">
      {isAsking && (
        <div className="chat-asking">
          <span>Claude is asking something. Answer it in the terminal.</span>
          <button className="tool primary" onClick={onShowTerminal}>
            Show terminal
          </button>
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
      <div className="chat-compose-row">
        <textarea
          ref={input}
          rows={1}
          value={draft}
          placeholder={isAsking ? 'Waiting on the question in the terminal…' : 'Message Claude: Enter sends, Shift+Enter for a new line'}
          disabled={isAsking}
          onChange={event => setDraft(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
            }
          }}
        />
        {state === 'working' && (
          <button className="tool" onClick={onEscape} title="Stop what Claude is doing (sends Esc)">
            ■ Esc
          </button>
        )}
        <button className="tool primary" onClick={() => void send()} disabled={!draft.trim() || isSending || isAsking}>
          {isSending ? 'Sending…' : 'Send ↵'}
        </button>
        {tools}
      </div>
    </div>
  )
}

/** A chat's conversation read from its transcript, with a box that types into its terminal. */
export function ChatView({ termKey, ...composer }: { termKey: string } & Composer) {
  const [items, setItems] = useState<ChatItem[]>([])
  const [isCut, setIsCut] = useState(false)
  const [state, setState] = useState<'loading' | 'ready' | 'none' | 'error'>('loading')
  const [error, setError] = useState('')
  const [isAtBottom, setIsAtBottom] = useState(true)
  const box = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const [limit, setLimit] = useState(PAGE)
  // Where the view stood before older entries were added above it, so it can stay on the same message.
  const keep = useRef<{ height: number; top: number } | null>(null)

  useEffect(() => {
    const id = `${projectId()}:${termKey}`
    const known = cache.get(id)
    setItems(known?.items ?? [])
    setIsCut(known?.isCut ?? false)
    setState(known ? (known.hasTranscript ? 'ready' : 'none') : 'loading')
    setLimit(PAGE)
    stick.current = true

    let source: EventSource | undefined
    let retry: ReturnType<typeof setTimeout> | undefined
    let isDone = false
    const connect = () => {
      const from = cache.get(id)?.next ?? -1
      const query = new URLSearchParams({ project: projectId() })
      if (from >= 0) query.set('from', String(from))
      source = new EventSource(`/api/chat/${encodeURIComponent(termKey)}/stream?${query}`)
      source.onmessage = event => {
        const page = JSON.parse(String(event.data)) as ChatPage
        const old = cache.get(id)
        const entry: Cached = {
          items: page.items.length ? [...(old?.items ?? []), ...page.items] : (old?.items ?? []),
          next: page.hasTranscript ? page.next : (old?.next ?? -1),
          isCut: old?.hasTranscript ? old.isCut : page.isCut,
          hasTranscript: page.hasTranscript || !!old?.hasTranscript,
        }
        cache.set(id, entry)
        setItems(entry.items)
        setIsCut(entry.isCut)
        setState(entry.hasTranscript ? 'ready' : 'none')
      }
      // The server restarting or a dropped connection: carry on from the last line received.
      source.onerror = () => {
        source?.close()
        if (isDone) return
        setError('Lost the connection to the server; trying again…')
        setState(old => (old === 'loading' ? 'error' : old))
        retry = setTimeout(connect, 1_000)
      }
    }
    connect()
    return () => {
      isDone = true
      source?.close()
      clearTimeout(retry)
    }
  }, [termKey])

  const results = useMemo(() => new Map(items.filter((i): i is Result => i.kind === 'result').map(r => [r.toolUseId, r])), [items])
  const entries = useMemo(() => entriesOf(items), [items])
  const shown = entries.length > limit ? entries.slice(-limit) : entries

  // New messages keep the view at the bottom only if it was there; reading further up is left alone.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    if (keep.current) {
      el.scrollTop = keep.current.top + (el.scrollHeight - keep.current.height)
      keep.current = null
    } else if (stick.current) el.scrollTop = el.scrollHeight
  }, [entries, limit, composer.state])

  const showEarlier = () => {
    if (box.current) keep.current = { height: box.current.scrollHeight, top: box.current.scrollTop }
    setLimit(limit + PAGE)
  }

  const onScroll = () => {
    const el = box.current
    if (!el) return
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    stick.current = atBottom
    if (atBottom !== isAtBottom) setIsAtBottom(atBottom)
  }

  // Links open in the real browser, never inside the app window.
  const onClick = (event: React.MouseEvent) => {
    const link = (event.target as HTMLElement).closest('a')
    if (!link?.href) return
    event.preventDefault()
    window.open(link.href, '_blank', 'noopener')
  }

  const empty =
    state === 'loading'
      ? 'Reading the conversation…'
      : state === 'none'
        ? 'No conversation yet. Send a message below, or start the chat in the terminal view.'
        : state === 'error'
          ? `Could not read the conversation: ${error}`
          : ''

  const toBottom = () => {
    stick.current = true
    setIsAtBottom(true)
    if (box.current) box.current.scrollTop = box.current.scrollHeight
  }

  return (
    <div className="chat-wrap">
      <div className="chat-scroll">
      {empty ? (
        <div className="chat-view chat-empty">{empty}</div>
      ) : (
      <div className="chat-view" ref={box} onScroll={onScroll} onClick={onClick}>
        {entries.length > limit ? (
          <button className="tool chat-earlier" onClick={showEarlier}>
            ↑ Show earlier ({entries.length - limit} more)
          </button>
        ) : (
          isCut && <div className="chat-notice">Earlier messages are not shown: this view starts from the latest part of a long chat.</div>
        )}
        {shown.map(entry => {
          if (entry.kind === 'steps') return <Steps key={entry.id} tools={entry.tools} results={results} />
          if (entry.kind === 'user')
            return (
              <div key={entry.id} className="chat-user">
                <Markdown text={entry.text} />
              </div>
            )
          if (entry.kind === 'assistant')
            return (
              <div key={entry.id} className="chat-assistant">
                <Markdown text={entry.text} />
              </div>
            )
          return (
            <div key={entry.id} className="chat-notice">
              {entry.text}
            </div>
          )
        })}
        {composer.state === 'working' && (
          // The conversation file gets a reply only once each part of it is finished, so a pause here
          // means Claude is still writing or running something, not that the view stalled.
          <div className="chat-working">
            <span className="chat-pulse" />
            Claude is working…
          </div>
        )}
      </div>
      )}
      {!empty && !isAtBottom && (
        <button className="tool primary chat-latest" onClick={toBottom}>
          ↓ Latest
        </button>
      )}
      </div>
      <Composer termKey={termKey} {...composer} onSent={toBottom} />
    </div>
  )
}
