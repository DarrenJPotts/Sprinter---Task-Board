import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Terminal as Xterm } from '@xterm/xterm'
import { useEffect, useRef } from 'react'

import { projectId } from './api'

// Always dark, in either theme: a terminal reads best light-on-dark. The cursor and selection take the board's yellow.
const themeFor = (_isDark: boolean) => ({
  background: '#1b1b1f',
  foreground: '#f4f4f0',
  cursor: '#ffdc58',
  cursorAccent: '#000000',
  selectionBackground: '#ffdc5855',
})

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
      fontFamily: "'Space Mono', 'Cascadia Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      scrollback: 5000,
      theme: themeFor(darkRef.current),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    termRef.current = term
    term.open(host.current)
    // Draw on the GPU: Claude Code repaints its whole screen often, which the default DOM renderer lags on.
    try {
      const gpu = new WebglAddon()
      gpu.onContextLoss(() => gpu.dispose())
      term.loadAddon(gpu)
    } catch {
      // No WebGL here: the DOM renderer carries on.
    }
    fit.fit()

    const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${scheme}://${location.host}/ws/terminals/${encodeURIComponent(projectId())}/${encodeURIComponent(termKey)}`)
    const send = (message: object) => socket.readyState === WebSocket.OPEN && socket.send(JSON.stringify(message))

    socket.onopen = () => send({ type: 'resize', cols: term.cols, rows: term.rows })
    socket.onmessage = event => {
      const message = JSON.parse(String(event.data)) as { type: string; data?: string }
      if (message.type === 'output' && message.data) term.write(message.data)
      if (message.type === 'exit') {
        term.write('\r\n\x1b[2m[session ended]\x1b[0m\r\n')
        exitRef.current()
      }
    }
    const typing = term.onData(data => send({ type: 'input', data }))

    const resize = new ResizeObserver(() => {
      fit.fit()
      send({ type: 'resize', cols: term.cols, rows: term.rows })
    })
    resize.observe(host.current)
    term.focus()

    return () => {
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
