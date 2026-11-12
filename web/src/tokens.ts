import type { TokenUsage } from '../../shared/types'

/** 1234 → 1.2k, 3456789 → 3.5M. */
export function compact(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

/** Tokens billed at or above the input rate: what a turn really costs. Cache reads are a tenth of that. */
export const billed = (u: TokenUsage) => u.input + u.cacheWrite + u.output

export const usageTitle = (u: TokenUsage) =>
  `${u.turns} requests · ${u.input.toLocaleString()} input · ${u.cacheWrite.toLocaleString()} cache write · ${u.cacheRead.toLocaleString()} cache read · ${u.output.toLocaleString()} output`
