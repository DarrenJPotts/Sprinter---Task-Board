import { useEffect, useRef, useState } from 'react'

type Ask = {
  title: string
  body?: string
  /** The button that goes ahead, e.g. "Forget". */
  confirm: string
  /** Red for something that stops or removes work; yellow otherwise. */
  isDanger?: boolean
}

type Pending = Ask & { resolve: (ok: boolean) => void }

// One dialog at a time, asked from anywhere: the host mounted in the app shows whatever is waiting.
let show: ((pending: Pending) => void) | null = null

/** Asks the user to confirm in the app's own dialog; resolves true only on the go-ahead button. */
export function ask(question: Ask): Promise<boolean> {
  return new Promise(resolve => {
    if (!show) {
      resolve(window.confirm(question.body ? `${question.title}\n\n${question.body}` : question.title))
      return
    }
    show({ ...question, resolve })
  })
}

/** Mount once: renders the dialog `ask` opens. Esc or a click outside cancels; Enter goes ahead. */
export function DialogHost() {
  const [pending, setPending] = useState<Pending | null>(null)
  const goAhead = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    show = next => setPending(next)
    return () => {
      show = null
    }
  }, [])

  useEffect(() => {
    if (!pending) return
    goAhead.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (!pending) return null
  function close(ok: boolean) {
    pending?.resolve(ok)
    setPending(null)
  }

  return (
    <div className="modal-back" onClick={() => close(false)}>
      <div
        className={`modal confirm${pending.isDanger ? ' danger' : ''}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        onClick={event => event.stopPropagation()}
      >
        <div className="confirm-band" />
        <h3 id="confirm-title">{pending.title}</h3>
        {pending.body && <p>{pending.body}</p>}
        <div className="confirm-actions">
          <button className="tool" onClick={() => close(false)}>
            Cancel
          </button>
          <button ref={goAhead} className={`tool ${pending.isDanger ? 'danger' : 'primary'}`} onClick={() => close(true)}>
            {pending.confirm}
          </button>
        </div>
      </div>
    </div>
  )
}
