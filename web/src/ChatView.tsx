import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { type ReactNode, memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'

import type { ChatItem, ChatPage, TerminalState, ChatPrompt } from '../../shared/types'
import { api, projectId } from './api'
import { ChangeCard } from './Diff'

type Tool = Extract<ChatItem, { kind: 'tool' }>
type Result = Extract<ChatItem, { kind: 'result' }>
type Entry =
  | Exclude<ChatItem, Tool | Result>
  | { kind: 'steps'; id: string; tools: Tool[] }
  | { kind: 'change'; id: string; tool: Tool }

// How many entries are drawn at first, and how many more each "Show earlier" adds.
const PAGE = 80

type Cached = { items: ChatItem[]; next: number; isCut: boolean; hasTranscript: boolean }
// Each chat's conversation stays in memory while the app is open, so coming back to it is instant and
// only what is new is read.
const cache = new Map<string, Cached>()

// Transcripts carry text from PRs, files and web pages: it is rendered as markdown but never trusted as HTML.
const Markdown = memo(function Markdown({ text }: { text: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false })), [text])
  const box = useRef<HTMLDivElement>(null)
  // Every code block gets a Copy button, added to the rendered page rather than the sanitised HTML.
  useLayoutEffect(() => {
    for (const pre of box.current?.querySelectorAll('pre') ?? []) {
      if (pre.querySelector('.copy-code')) continue
      const button = document.createElement('button')
      button.className = 'copy-code'
      button.type = 'button'
      button.textContent = 'Copy'
      button.onclick = event => {
        event.stopPropagation()
        void navigator.clipboard?.writeText(pre.querySelector('code')?.textContent ?? pre.textContent ?? '').then(() => {
          button.textContent = 'Copied'
          setTimeout(() => (button.textContent = 'Copy'), 1500)
        })
      }
      pre.append(button)
    }
  }, [html])
  return <div ref={box} className="md" dangerouslySetInnerHTML={{ __html: html }} />
})

/** A message's time, and a button that copies its text: shown on hover. */
function MessageMeta({ at, text }: { at?: string; text: string }) {
  const [isCopied, setIsCopied] = useState(false)
  return (
    <div className="chat-meta">
      {at && <time dateTime={at}>{new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>}
      <button
        type="button"
        onClick={() =>
          void navigator.clipboard?.writeText(text).then(() => {
            setIsCopied(true)
            setTimeout(() => setIsCopied(false), 1500)
          })
        }
      >
        {isCopied ? 'Copied' : 'Copy'}
      </button>
    </div>
  )
}

// What you were typing in each chat, and what you sent there: kept while the app is open, so switching
// tabs keeps a half-written message and ↑ brings back an earlier one.
/** Claude Code swaps an image's path for "[Image #1]", so a sent message is matched to the transcript without either. */
const withoutImages = (text: string) =>
  text
    .replace(/\[Image #\d+\]/g, ' ')
    .replace(/\S+\.(png|jpe?g|gif|webp)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()

const drafts = new Map<string, string>()
const history = new Map<string, string[]>()

const since = (iso: string | undefined, now: number) => {
  if (!iso) return ''
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000))
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

/**
 * Tool calls in a row fold into one line; the results are matched to their calls by id. A file edit
 * stands on its own as a diff, since what Claude writes is what you are there to follow.
 */
function entriesOf(items: ChatItem[]): Entry[] {
  const out: Entry[] = []
  for (const item of items) {
    if (item.kind === 'result') continue
    if (item.kind === 'tool' && item.change) {
      out.push({ kind: 'change', id: `change-${item.id}`, tool: item })
      continue
    }
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
  /** The choice Claude is waiting on, read off its screen, and how to answer it. */
  prompt?: ChatPrompt
  /** Picks an option; with `isMoveOnly`, only highlights it, so its preview shows. */
  onChoose?: (index: number, text?: string, isMoveOnly?: boolean) => Promise<unknown>
  /** Commands worth one click, such as the ticket's next step: a click puts one in the box. */
  suggestions?: string[]
}

/** The box under the conversation: what is typed goes to the chat's terminal, as if typed there. */
function Composer({ termKey, isLive, state, onSend, onEscape, onResume, onShowTerminal, tools, onSent, prompt, onChoose, suggestions }: Composer & { termKey: string; onSent: (text?: string) => void }) {
  const [draft, setDraftState] = useState(() => drafts.get(termKey) ?? '')
  const setDraft = (text: string) => {
    drafts.set(termKey, text)
    setDraftState(text)
  }
  // Where ↑ and ↓ are in this chat's sent messages; -1 is the message being written.
  const recall = useRef(-1)
  const [isSending, setIsSending] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLTextAreaElement>(null)
  // Images still uploading; Send waits for them, so a message never goes without the paths it should carry.
  const [attaching, setAttaching] = useState(0)
  const shownKey = useRef(termKey)
  shownKey.current = termKey

  /** Saves pasted or dropped images and puts each one's path where the cursor is: Claude reads it from there. */
  const attach = (files: File[]) => {
    const images = files.filter(file => file.type.startsWith('image/'))
    if (images.length === 0) return false
    const key = termKey
    setAttaching(count => count + images.length)
    setError('')
    void Promise.all(images.map(image => api.saveImage(image)))
      .then(saved => {
        const paths = saved.map(image => image.path).join(' ')
        const old = drafts.get(key) ?? ''
        // Switched to another chat while it uploaded: the path still lands in this chat's draft, at its end.
        if (shownKey.current !== key) {
          drafts.set(key, `${old}${old && !/\s$/.test(old) ? ' ' : ''}${paths} `)
          return
        }
        const el = input.current
        const start = el?.selectionStart ?? old.length
        const before = old.slice(0, start)
        const after = old.slice(el?.selectionEnd ?? start)
        const head = `${before}${before && !/\s$/.test(before) ? ' ' : ''}${paths} `
        setDraft(head + after.replace(/^\s+/, ''))
        requestAnimationFrame(() => {
          input.current?.focus()
          input.current?.setSelectionRange(head.length, head.length)
        })
      })
      .catch(caught => setError(`Could not attach the image: ${caught instanceof Error ? caught.message : String(caught)}`))
      .finally(() => setAttaching(count => count - images.length))
    return true
  }
  // A question on screen (a permission prompt, a choice) reads keys, not a message: typing into it could pick an option.
  const isAsking = state === 'asking'
  // When the question's options can be read, they are answered here; otherwise only in the terminal.
  const choice = isAsking && onChoose ? prompt : undefined
  // "Type something." turns the message box into the answer box.
  const isTypedAnswer = choice?.typed !== undefined
  // A question with a preview shows it for the highlighted option only, so a click there highlights first and
  // a second click (or Choose) answers; without one, a click answers at once.
  const hasPreview = choice?.preview !== undefined
  const pick = async (index: number, text?: string, isMoveOnly = false) => {
    if (!onChoose || isSending) return
    setIsSending(true)
    setError('')
    try {
      await onChoose(index, text, isMoveOnly)
      if (isMoveOnly) return
      // Only a typed answer used the box; a picked option leaves a message being written (and its images) alone.
      if (text !== undefined) setDraft('')
      onSent()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setIsSending(false)
    }
  }

  useEffect(() => {
    setDraftState(drafts.get(termKey) ?? '')
    setError('')
    recall.current = -1
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
    if (isTypedAnswer && text) return pick(choice!.typed!, text)
    if (!text || isSending || attaching > 0 || !isLive || isAsking) return
    setIsSending(true)
    setError('')
    try {
      await onSend(text)
      setDraft('')
      history.set(termKey, [...(history.get(termKey) ?? []).filter(old => old !== text), text].slice(-50))
      recall.current = -1
      onSent(text)
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
      {choice && (
        <div className="chat-choice" role="group" aria-label={choice.question || 'Claude is asking'}>
          <div className="chat-choice-head">
            <span className="chat-choice-tabs">{choice.header || 'Claude is asking'}</span>
            <button className="chat-choice-terminal" onClick={onShowTerminal} title="Answer in the terminal instead">
              Terminal ↗
            </button>
          </div>
          {/* Questions carry markdown (bold, code, lists) that the terminal shows raw. */}
          {choice.question && (
            <div className="chat-choice-question">
              <Markdown text={choice.question} />
            </div>
          )}
          <div className={`chat-choice-options${choice.details ? ' detailed' : ''}`}>
            {choice.options.map((option, index) => {
              if (index === choice.typed) return null
              const isHighlighted = index === choice.selected
              const detail = choice.details?.[index]
              return (
                <button
                  key={option + index}
                  className={`tool${isHighlighted ? ' primary' : ''}`}
                  disabled={isSending}
                  aria-pressed={hasPreview ? isHighlighted : undefined}
                  onClick={() => void pick(index, undefined, hasPreview && !isHighlighted)}
                  title={
                    hasPreview ? (isHighlighted ? 'Choose this answer' : 'Show its preview; click again to choose it') : isHighlighted ? 'Highlighted in the terminal now' : undefined
                  }
                >
                  <span className="chat-choice-n">{index + 1}</span> <span className="chat-choice-label">{option}</span>
                  {detail && <span className="chat-choice-detail">{detail}</span>}
                </button>
              )
            })}
          </div>
          {hasPreview && (
            <div className="chat-choice-preview">
              <div className="chat-choice-preview-head">
                <span>
                  Preview · <strong>{choice.options[choice.selected]}</strong>
                </span>
                <button className="tool primary" disabled={isSending} onClick={() => void pick(choice.selected)}>
                  Choose {choice.selected + 1}
                </button>
              </div>
              <pre>{choice.preview}</pre>
            </div>
          )}
          {isTypedAnswer && <span className="count">Or type your own answer below.</span>}
        </div>
      )}
      {isAsking && !choice && (
        <div className="chat-asking">
          <span>Claude is asking something. Answer it in the terminal.</span>
          <button className="tool primary" onClick={onShowTerminal}>
            Show terminal
          </button>
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
      {!isAsking && !draft && suggestions && suggestions.length > 0 && (
        <div className="chat-suggestions">
          {suggestions.map(command => (
            <button
              key={command}
              type="button"
              className="chat-suggestion"
              title="Put this in the box; Enter sends it"
              onClick={() => {
                setDraft(command)
                input.current?.focus()
              }}
            >
              ▶ <code>{command}</code>
            </button>
          ))}
        </div>
      )}
      <div className="chat-compose-row">
        <textarea
          ref={input}
          rows={1}
          value={draft}
          placeholder={
            isTypedAnswer
              ? 'Your own answer: Enter sends it'
              : isAsking
                ? 'Pick an answer above, or in the terminal'
                : 'Message Claude: Enter sends, Shift+Enter for a new line, paste or drop an image to attach it'
          }
          disabled={isAsking && !isTypedAnswer}
          onChange={event => setDraft(event.target.value)}
          onPaste={event => {
            if (attach([...event.clipboardData.files])) event.preventDefault()
          }}
          onDragOver={event => {
            if (event.dataTransfer.types.includes('Files')) event.preventDefault()
          }}
          onDrop={event => {
            if (!attach([...event.dataTransfer.files])) return
            event.preventDefault()
            event.stopPropagation()
          }}
          onKeyDown={event => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              void send()
              return
            }
            // ↑ in an empty box (or one showing a recalled message) steps back through what was sent; ↓ forward.
            const sent = history.get(termKey) ?? []
            const isRecalling = recall.current >= 0 && draft === sent[sent.length - 1 - recall.current]
            if (event.key === 'ArrowUp' && (draft === '' || isRecalling) && recall.current < sent.length - 1) {
              event.preventDefault()
              recall.current += 1
              setDraft(sent[sent.length - 1 - recall.current]!)
            } else if (event.key === 'ArrowDown' && isRecalling) {
              event.preventDefault()
              recall.current -= 1
              setDraft(recall.current >= 0 ? sent[sent.length - 1 - recall.current]! : '')
            }
          }}
        />
        {state === 'working' && (
          <button className="tool" onClick={onEscape} title="Stop what Claude is doing (sends Esc)">
            ■ Esc
          </button>
        )}
        <button className="tool primary" onClick={() => void send()} disabled={!draft.trim() || isSending || attaching > 0 || (isAsking && !isTypedAnswer)}>
          {isSending ? 'Sending…' : attaching > 0 ? 'Attaching…' : 'Send ↵'}
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

  // Messages sent from here, shown at once until the transcript has them.
  const [pending, setPending] = useState<{ id: string; text: string; at: number }[]>([])
  const [now, setNow] = useState(() => Date.now())

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

  // A sent message leaves the pending list once the transcript shows it (or after a minute regardless).
  useEffect(() => {
    if (pending.length === 0) return
    const users = items.filter(i => i.kind === 'user')
    const left = pending.filter(
      p =>
        Date.now() - p.at < 60_000 &&
        !users.some(u => u.kind === 'user' && Date.parse(u.at ?? '') >= p.at - 5_000 && withoutImages(u.text).includes(withoutImages(p.text).slice(0, 80))),
    )
    if (left.length !== pending.length) setPending(left)
  }, [items, pending])
  useEffect(() => setPending([]), [termKey])

  // While Claude works, the line under the conversation counts up once a second.
  const isWorking = composer.state === 'working'
  useEffect(() => {
    if (!isWorking) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [isWorking])
  const lastUser = [...items].reverse().find(i => i.kind === 'user')
  const lastTool = [...items].reverse().find((i): i is Tool => i.kind === 'tool')
  const startedAt = pending.at(-1) ? new Date(pending.at(-1)!.at).toISOString() : lastUser?.at
  // A chat that is just starting up (resumed, say) also draws a lot; then the last message is old and its
  // time and step would mislead, so they show only for a turn begun in the last two hours.
  const isRecentTurn = Boolean(startedAt) && now - Date.parse(startedAt!) < 2 * 60 * 60_000
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
          if (entry.kind === 'change') return <ChangeCard key={entry.id} tool={entry.tool} result={results.get(entry.tool.id)} />
          if (entry.kind === 'user')
            return (
              <div key={entry.id} className="chat-user">
                <Markdown text={entry.text} />
                <MessageMeta at={entry.at} text={entry.text} />
              </div>
            )
          if (entry.kind === 'assistant')
            return (
              <div key={entry.id} className="chat-assistant">
                <Markdown text={entry.text} />
                <MessageMeta at={entry.at} text={entry.text} />
              </div>
            )
          return (
            <div key={entry.id} className="chat-notice">
              {entry.text}
            </div>
          )
        })}
        {pending.map(p => (
          <div key={p.id} className="chat-user pending" title="Sent; it shows here for good once Claude has it">
            <Markdown text={p.text} />
            <div className="chat-meta always">sending…</div>
          </div>
        ))}
        {isWorking && (
          // The conversation file gets a reply only once each part of it is finished, so a pause here
          // means Claude is still writing or running something, not that the view stalled.
          <div className="chat-working">
            <span className="chat-pulse" />
            <span>
              Claude is working{isRecentTurn ? ` · ${since(startedAt, now)}` : ''}
              {isRecentTurn && lastTool && Date.parse(lastTool.at ?? '') >= Date.parse(startedAt ?? '') && (
                <span className="chat-working-step">
                  {' '}
                  · {lastTool.name.replace(/^mcp__[^_]+__/, '')} {lastTool.summary}
                </span>
              )}
            </span>
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
      <Composer
        termKey={termKey}
        {...composer}
        onSent={text => {
          if (text) setPending(list => [...list, { id: `p${Date.now()}`, text, at: Date.now() }])
          toBottom()
        }}
      />
    </div>
  )
}
