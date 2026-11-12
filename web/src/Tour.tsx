import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

/** One stop on the tour: what to point at, and what to say about it. */
export type TourStep = {
  title: string
  body: string
  /** The element to point at; a step whose target is not on screen is skipped. */
  target: () => Element | null
}

type Box = { left: number; top: number; width: number; height: number }

const GAP = 72 // room between the bubble and its target, for the connector line
const MARGIN = 16
const BUBBLE_W = 340

/** The first element matching `selector` whose text includes `text`. */
export const byText = (selector: string, text: string) => () =>
  [...document.querySelectorAll(selector)].find(el => el.textContent?.includes(text)) ?? null

const visible = (el: Element | null | undefined): el is Element => {
  if (!el) return false
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0
}

/** Puts the bubble on whichever side of the target has room, kept inside the window. */
function place(target: DOMRect, bubble: { width: number; height: number }): Box & { side: string } {
  const vw = window.innerWidth
  const vh = window.innerHeight
  const room = {
    below: vh - target.bottom,
    above: target.top,
    right: vw - target.right,
    left: target.left,
  }
  const fits = {
    below: room.below >= bubble.height + GAP + MARGIN,
    above: room.above >= bubble.height + GAP + MARGIN,
    right: room.right >= bubble.width + GAP + MARGIN,
    left: room.left >= bubble.width + GAP + MARGIN,
  }
  const side = (['below', 'above', 'right', 'left'] as const).find(s => fits[s]) ?? (room.below > room.above ? 'below' : 'above')
  const clampX = (x: number) => Math.min(Math.max(MARGIN, x), vw - bubble.width - MARGIN)
  const clampY = (y: number) => Math.min(Math.max(MARGIN, y), vh - bubble.height - MARGIN)
  const midX = target.left + target.width / 2 - bubble.width / 2
  const midY = target.top + target.height / 2 - bubble.height / 2
  const at = {
    below: { left: clampX(midX + 60), top: clampY(target.bottom + GAP) },
    above: { left: clampX(midX + 60), top: clampY(target.top - GAP - bubble.height) },
    right: { left: clampX(target.right + GAP), top: clampY(midY + 30) },
    left: { left: clampX(target.left - GAP - bubble.width), top: clampY(midY + 30) },
  }[side]

  return { ...at, width: bubble.width, height: bubble.height, side }
}

/** Where the connector meets a box: the middle of the edge facing the other box. */
function edgePoint(box: Box, toward: { x: number; y: number }) {
  const cx = box.left + box.width / 2
  const cy = box.top + box.height / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  // Leave by the side the other point lies past, scaled to the box's shape.
  if (Math.abs(dx) * box.height > Math.abs(dy) * box.width) {
    return { x: dx > 0 ? box.left + box.width : box.left, y: Math.min(Math.max(cy + dy * 0.25, box.top + 8), box.top + box.height - 8) }
  }
  return { x: Math.min(Math.max(cx + dx * 0.25, box.left + 12), box.left + box.width - 12), y: dy > 0 ? box.top + box.height : box.top }
}

/**
 * A guided tour: the page dims, the step's target is spotlit, and a bubble beside it,
 * joined to it by a line, says what it is. Arrow keys or the buttons move through it.
 */
export function Tour({ steps, onClose }: { steps: TourStep[]; onClose: () => void }) {
  const [at, setAt] = useState(0)
  const [target, setTarget] = useState<DOMRect | null>(null)
  const [bubble, setBubble] = useState<(Box & { side: string }) | null>(null)
  const bubbleRef = useRef<HTMLDivElement>(null)
  // Only steps whose target is on screen now: a closed side panel's steps drop out.
  const [shown] = useState(() => steps.filter(step => visible(step.target())))
  const step = shown[at]

  const measure = useCallback(() => {
    const el = step?.target()
    if (!visible(el)) return
    const rect = el.getBoundingClientRect()
    setTarget(rect)
    const size = bubbleRef.current?.getBoundingClientRect()
    setBubble(place(rect, { width: BUBBLE_W, height: size?.height ?? 160 }))
  }, [step])

  useLayoutEffect(() => {
    step?.target()?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    measure()
    // Measure again once the bubble has drawn at its real height.
    const frame = requestAnimationFrame(measure)
    return () => cancelAnimationFrame(frame)
  }, [measure, step])

  useEffect(() => {
    window.addEventListener('resize', measure)
    window.addEventListener('scroll', measure, true)
    return () => {
      window.removeEventListener('resize', measure)
      window.removeEventListener('scroll', measure, true)
    }
  }, [measure])

  const next = useCallback(() => (at + 1 < shown.length ? setAt(at + 1) : onClose()), [at, shown.length, onClose])
  const back = useCallback(() => setAt(Math.max(0, at - 1)), [at])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
      if (event.key === 'ArrowRight' || event.key === 'Enter') next()
      if (event.key === 'ArrowLeft') back()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [next, back, onClose])

  if (!step) return null

  const spot = target && { left: target.left - 6, top: target.top - 6, width: target.width + 12, height: target.height + 12 }
  const from = bubble && spot && edgePoint(bubble, { x: spot.left + spot.width / 2, y: spot.top + spot.height / 2 })
  const to = bubble && spot && edgePoint(spot, { x: bubble.left + bubble.width / 2, y: bubble.top + bubble.height / 2 })

  return (
    <div className="tour" role="dialog" aria-label={`Tour step ${at + 1} of ${shown.length}: ${step.title}`}>
      {spot && <div className="tour-spot" style={spot} />}
      {from && to && (
        <svg className="tour-line" width="100%" height="100%">
          <line x1={from.x} y1={from.y} x2={to.x} y2={to.y} />
          <circle cx={to.x} cy={to.y} r="6" />
        </svg>
      )}
      <div
        ref={bubbleRef}
        className="tour-bubble"
        style={bubble ? { left: bubble.left, top: bubble.top, width: BUBBLE_W } : { left: -9999, top: 0, width: BUBBLE_W }}
      >
        <div className="tour-count">
          {at + 1} / {shown.length}
        </div>
        <h3>{step.title}</h3>
        <p>{step.body}</p>
        <div className="tour-actions">
          <button className="tool" onClick={onClose}>
            Skip tour
          </button>
          <div className="spacer" />
          {at > 0 && (
            <button className="tool" onClick={back}>
              ← Back
            </button>
          )}
          <button className="tool primary" onClick={next} autoFocus>
            {at + 1 < shown.length ? 'Next →' : 'Done'}
          </button>
        </div>
      </div>
    </div>
  )
}
