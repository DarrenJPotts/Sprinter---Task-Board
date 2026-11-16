import { useLayoutEffect } from 'react'
import type { RefObject } from 'react'

const MARGIN = 8
// Below this much room under its button, a dropdown opens upward if there is more room above.
const MIN_BELOW = 260

/**
 * Keeps an open dropdown inside the window: taller than the room below its button, it opens upward when
 * there is more room there, else it scrolls; past either side, it slides back in. Its button stays put.
 */
export function useKeepOnScreen(host: RefObject<HTMLElement | null>, isOpen: boolean, selector = ':scope > .popover, :scope > .menu') {
  useLayoutEffect(() => {
    if (!isOpen) return
    const place = () => {
      const box = host.current
      const el = box?.querySelector<HTMLElement>(selector)
      if (!box || !el) return
      for (const prop of ['transform', 'maxHeight', 'maxWidth', 'top', 'bottom'] as const) el.style[prop] = ''

      const anchor = box.getBoundingClientRect()
      const below = innerHeight - anchor.bottom - MARGIN * 2
      const above = anchor.top - MARGIN * 2
      let rect = el.getBoundingClientRect()
      if (rect.bottom > innerHeight - MARGIN) {
        if (below < MIN_BELOW && above > below) {
          el.style.top = 'auto'
          el.style.bottom = 'calc(100% + 10px)'
          el.style.maxHeight = `${Math.round(above)}px`
        } else {
          el.style.maxHeight = `${Math.round(Math.max(160, below))}px`
        }
        el.style.overflowY = 'auto'
        rect = el.getBoundingClientRect()
      }

      if (rect.width > innerWidth - MARGIN * 2) {
        el.style.maxWidth = `${innerWidth - MARGIN * 2}px`
        rect = el.getBoundingClientRect()
      }
      let shift = 0
      if (rect.right > innerWidth - MARGIN) shift = innerWidth - MARGIN - rect.right
      if (rect.left + shift < MARGIN) shift = MARGIN - rect.left
      if (shift) el.style.transform = `translateX(${Math.round(shift)}px)`
    }
    place()
    window.addEventListener('resize', place)
    return () => window.removeEventListener('resize', place)
  })
}
