import { FitAddon } from '@xterm/addon-fit'
import { Terminal as Xterm } from '@xterm/xterm'
import { useEffect, useRef } from 'react'

import { projectId } from './api'

// Always dark, in either theme: a terminal reads best light-on-dark. The cursor and selection take the
// board's yellow. Grey ("bright black") is what Claude Code uses for most secondary text, so it is set
// well clear of the background instead of the near-black default.
const themeFor = (_isDark: boolean) => ({
  background: '#1b1b1f',
  foreground: '#ececec',
  cursor: '#ffdc58',
  cursorAccent: '#000000',
  selectionBackground: '#ffdc5866',
  black: '#2e2e33',
  red: '#ff7b72',
  green: '#7ee787',
  yellow: '#f2cc60',
  blue: '#79c0ff',
  magenta: '#d2a8ff',
  cyan: '#76e3ea',
  white: '#d8d8d8',
  brightBlack: '#a0a0a8',
  brightRed: '#ffa198',
  brightGreen: '#a5f0ae',
  brightYellow: '#ffdf8a',
  brightBlue: '#a5d6ff',
  brightMagenta: '#e2c5ff',
  brightCyan: '#b3f0f5',
  brightWhite: '#ffffff',
})

// Fonts installed with Windows (and their usual stand-ins elsewhere). A web font here loads after the
// terminal has measured its cells, which spaces the letters out ("Cl aude"), so none is used.
const FONT = "'Cascadia Mono', 'Cascadia Code', Consolas, 'SF Mono', Menlo, 'DejaVu Sans Mono', monospace"

/** One ticket's live terminal, attached over a socket; switching `termKey` re-attaches. */
export function Terminal({ termKey, isDark, onExit }: { termKey: string; isDark: boolean; onExit: () => void }) {
  const host = useRef<HTMLDivElement>(null)
  const termRef = useRef<Xterm | null>(null)
  const darkRef = useRef(isDark)
  darkRef.current = isDark
  const exitRef = useRef(onExit)
  exitRef.current = onExit

  useEffect(() => {
    if (!host.current) return
    const term = new Xterm({
      fontFamily: FONT,
      fontSize: 14,
      lineHeight: 1.25,
      letterSpacing: 0,
      cursorBlink: true,
      scrollback: 5000,
      // Text the program dims anyway is lifted to readable contrast against the background.
      minimumContrastRatio: 4.5,
      theme: themeFor(darkRef.current),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    term.open(host.current)
    // The standard renderer, not the GPU one: the GPU renderer drew nothing in some windows and spaced
    // letters out when its font measure ran early; the lag it was added for came from the server.
    fit.fit()
    // If a font finishes loading after the first measure, measure the cells again.
    void document.fonts.ready.then(() => {
      if (termRef.current !== term) return
      term.options.fontFamily = FONT
      fit.fit()
    })

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${location.host}/ws/terminals/${encodeURIComponent(projectId())}/${encodeURIComponent(termKey)}`)
    const send = (message: object) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message))

    socket.onopen = () => {
      sent = `${term.cols}x${term.rows}`
      send({ type: 'resize', cols: term.cols, rows: term.rows })
    }
    let queued = ''
    let frame: number | null = null
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string }
      if (message.type === 'output' && message.data) {
        // Everything that arrives within one frame is drawn in one go: no half-repainted screen shows.
        queued += message.data
        frame ??= requestAnimationFrame(() => {
          frame = null
          term.write(queued)
          queued = ''
        })
      }
      if (message.type === 'exit') {
        term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
        exitRef.current()
      }
    }
    const typing = term.onData(data => send({ type: 'input', data }))

    // A resize makes Claude Code clear and repaint its whole screen, so the pane reports a new size
    // only once it has settled, and only when the grid really changed.
    let sent = ''
    let settle: ReturnType<typeof setTimeout> | undefined
    const resize = new ResizeObserver(() => {
      clearTimeout(settle)
      settle = setTimeout(() => {
        fit.fit()
        const size = `${term.cols}x${term.rows}`
        if (size === sent) return
        sent = size
        send({ type: 'resize', cols: term.cols, rows: term.rows })
      }, 120)
    })
    resize.observe(host.current)
    term.focus()

    return () => {
      clearTimeout(settle)
      if (frame !== null) cancelAnimationFrame(frame)
      termRef.current = null
      resize.disconnect()
      typing.dispose()
      socket.close()
      term.dispose()
    }
  }, [termKey])

  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeFor(isDark)
  }, [isDark])

  return <div className="term" ref={host} />
}
