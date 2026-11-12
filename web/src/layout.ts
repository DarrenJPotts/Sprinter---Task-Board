// The side panel's split layout: a tree of panes. Each pane holds tabs and shows one;
// a split lays two children side by side (row) or one above the other (column).

export type PaneNode = { kind: 'pane'; id: string; tabs: string[]; active: string | null }
export type SplitNode = { kind: 'split'; id: string; dir: 'row' | 'column'; ratio: number; a: LayoutNode; b: LayoutNode }
export type LayoutNode = PaneNode | SplitNode
export type Zone = 'left' | 'right' | 'top' | 'bottom' | 'center'

let counter = 0
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`

export const emptyPane = (tabs: string[] = [], active: string | null = null): PaneNode => ({
  kind: 'pane',
  id: newId('pane'),
  tabs,
  active: active ?? tabs[0] ?? null,
})

export function panes(node: LayoutNode | null): PaneNode[] {
  if (!node) return []
  return node.kind === 'pane' ? [node] : [...panes(node.a), ...panes(node.b)]
}

export const allTabs = (node: LayoutNode | null) => panes(node).flatMap(p => p.tabs)

export const paneOf = (node: LayoutNode | null, key: string) => panes(node).find(p => p.tabs.includes(key))

function mapPanes(node: LayoutNode, change: (pane: PaneNode) => LayoutNode | null): LayoutNode | null {
  if (node.kind === 'pane') return change(node)
  const a = mapPanes(node.a, change)
  const b = mapPanes(node.b, change)
  // A split whose side emptied out collapses into the side that is left.
  if (!a) return b
  if (!b) return a
  return { ...node, a, b }
}

/** Shows `key`: where it is already open, else as a new tab in the pane `into` (or the first pane). */
export function openTab(node: LayoutNode | null, key: string, into?: string): { layout: LayoutNode; paneId: string } {
  const existing = paneOf(node, key)
  if (node && existing) {
    return { layout: mapPanes(node, p => (p.id === existing.id ? { ...p, active: key } : p))!, paneId: existing.id }
  }
  if (!node) {
    const pane = emptyPane([key], key)
    return { layout: pane, paneId: pane.id }
  }
  const target = panes(node).find(p => p.id === into) ?? panes(node)[0]!
  return {
    layout: mapPanes(node, p => (p.id === target.id ? { ...p, tabs: [...p.tabs, key], active: key } : p))!,
    paneId: target.id,
  }
}

/** Closes a tab; a pane left with no tabs disappears, and its split with it. */
export function closeTab(node: LayoutNode | null, key: string): LayoutNode | null {
  if (!node) return null
  return mapPanes(node, p => {
    if (!p.tabs.includes(key)) return p
    const tabs = p.tabs.filter(t => t !== key)
    if (tabs.length === 0) return null
    const at = p.tabs.indexOf(key)
    return { ...p, tabs, active: p.active === key ? (tabs[Math.max(0, at - 1)] ?? null) : p.active }
  })
}

export function activate(node: LayoutNode | null, paneId: string, key: string): LayoutNode | null {
  if (!node) return null
  return mapPanes(node, p => (p.id === paneId ? { ...p, active: key } : p))
}

/**
 * Moves a tab onto a pane: into its tabs (`center`), or to one side of it, splitting
 * that pane in two with the tab alone in the new half.
 */
export function moveTab(node: LayoutNode | null, key: string, targetId: string, zone: Zone): { layout: LayoutNode | null; paneId: string | null } {
  if (!node) return { layout: null, paneId: null }
  const source = paneOf(node, key)
  if (!source) return { layout: node, paneId: null }
  // Dropping a pane's only tab onto its own centre, or splitting a pane by its only tab, changes nothing.
  if (source.id === targetId && (zone === 'center' || source.tabs.length === 1)) return { layout: node, paneId: source.id }

  const without = closeTab(node, key)
  if (!without) return { layout: emptyPane([key], key), paneId: null }
  // If the source pane collapsed and was the target, fall back to the first pane.
  const target = panes(without).find(p => p.id === targetId) ?? panes(without)[0]!

  if (zone === 'center') {
    return {
      layout: mapPanes(without, p => (p.id === target.id ? { ...p, tabs: [...p.tabs, key], active: key } : p)),
      paneId: target.id,
    }
  }
  const fresh = emptyPane([key], key)
  const dir = zone === 'left' || zone === 'right' ? 'row' : 'column'
  const isFirst = zone === 'left' || zone === 'top'
  return {
    layout: mapPanes(without, p =>
      p.id === target.id
        ? { kind: 'split', id: newId('split'), dir, ratio: 0.5, a: isFirst ? fresh : p, b: isFirst ? p : fresh }
        : p,
    ),
    paneId: fresh.id,
  }
}

export function setRatio(node: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (node.kind === 'pane') return node
  if (node.id === splitId) return { ...node, ratio: Math.min(0.85, Math.max(0.15, ratio)) }
  return { ...node, a: setRatio(node.a, splitId, ratio), b: setRatio(node.b, splitId, ratio) }
}

/** Which part of a pane the pointer is over: an edge band of a quarter of its size, else the centre. */
export function zoneAt(rect: DOMRect, x: number, y: number): Zone {
  const fx = (x - rect.left) / rect.width
  const fy = (y - rect.top) / rect.height
  const edge = Math.min(fx, 1 - fx, fy, 1 - fy)
  if (edge > 0.25) return 'center'
  if (edge === fx) return 'left'
  if (edge === 1 - fx) return 'right'
  if (edge === fy) return 'top'
  return 'bottom'
}
