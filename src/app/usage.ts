/** Records what each model request in the managed Sessions cost, for the cost panel and later evaluation. */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined

const count = (source: Record<string, unknown>, key: string): number => {
  const value = source[key]
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** DeepSeek list prices in yuan per million tokens: a cached prompt token costs a tenth of a fresh one. */
export const PRICES_YUAN_PER_MILLION = { cacheRead: 0.1, input: 1, output: 2 } as const

/** Below this share of prompt tokens served from cache, the run pays the full input price for a prefix that should be warm. */
export const LOW_CACHE_HIT_RATE = 0.3

/** One model request's usage, in the shape DeepSeek Harness reports it. */
export interface UsageLine {
  /** When the request finished, ISO 8601. */
  readonly at: string
  /** The Session the request ran in. */
  readonly sessionId: string
  /** Whether the request ran in the main Session or in a Ticket's worker. */
  readonly role: 'main' | 'worker'
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
}

/** The slice of a DSH session event the ledger reads. */
export interface UsageEvent {
  readonly type: string
  readonly time: number
  readonly data: unknown
}

/** Totals over a window of usage lines; costs are left to the panel, which knows the current prices. */
export interface UsageTotals {
  /** How many model requests the window covers. */
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
  /**
   * The share of prompt tokens the provider served from its cache: cached tokens over input plus cached tokens. The two
   * are reported apart, so a provider that counts cached tokens inside the input total would make this an underestimate.
   */
  readonly cacheHitRate: number
  /** What the window cost at list prices, in yuan: a cached prompt token is charged a tenth of a fresh one. */
  readonly estimatedYuan: number
}

export interface UsageLedgerHost {
  /** The state directory the ledger appends `usage.jsonl` to. */
  readonly stateDir: string
  readonly now: () => Date
  /** How many of the newest lines a total reads; defaults to the whole file. */
  readonly maxLines?: number
}

/**
 * Why a run's prompt cache is not paying off, when the share of cached prompt tokens stays under `LOW_CACHE_HIT_RATE` over
 * enough requests to mean something. A cold start alone never trips it, so the alert marks a prefix that keeps changing.
 */
export function usageAlert(totals: UsageTotals): string | undefined {
  if (totals.calls < 5 || totals.cacheHitRate >= LOW_CACHE_HIT_RATE) return undefined
  const percent = (totals.cacheHitRate * 100).toFixed(1)
  return `${percent}% of prompt tokens came from cache over ${totals.calls} requests: check that the prompt prefix stays stable, or every turn pays the full input price.`
}

/** One Session's share of a window, with the same totals a whole window reports. */
export interface UsageGroup {
  readonly sessionId: string
  readonly role: 'main' | 'worker'
  readonly totals: UsageTotals
}

/** Totals a list of lines, so a whole window and one Session's share are added up the same way. */
const totalOf = (lines: UsageLine[]): UsageTotals => {
  const sum = (key: keyof Omit<UsageLine, 'at' | 'sessionId' | 'role'>): number => lines.reduce((total, line) => total + line[key], 0)
  const inputTokens = sum('inputTokens')
  const cacheReadTokens = sum('cacheReadTokens')
  const prompts = inputTokens + cacheReadTokens
  const outputTokens = sum('outputTokens')
  return {
    calls: lines.length,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens: sum('cacheWriteTokens'),
    reasoningTokens: sum('reasoningTokens'),
    cacheHitRate: prompts === 0 ? 0 : Number((cacheReadTokens / prompts).toFixed(4)),
    estimatedYuan: Number(((inputTokens * PRICES_YUAN_PER_MILLION.input + cacheReadTokens * PRICES_YUAN_PER_MILLION.cacheRead
      + outputTokens * PRICES_YUAN_PER_MILLION.output) / 1_000_000).toFixed(6)),
  }
}

/**
 * Keeps the usage of every model request the managed Sessions make, one JSON line per request in the state directory.
 * The line is written from the `assistant/message` event's `usage`, which DeepSeek Harness fills with the input, output,
 * cache-read, cache-write and reasoning token counts, so no provider call is repeated to learn what a turn cost. Writing
 * is best effort: a full disk never fails a turn, and a missing line only under-reports a total.
 */
export class UsageLedger {
  constructor(private readonly host: UsageLedgerHost) {}

  /** The path of the usage log. */
  get path(): string {
    return join(this.host.stateDir, 'usage.jsonl')
  }

  /** Appends the usage of one `assistant/message` event, and returns the line it wrote. */
  observe(sessionId: string, role: 'main' | 'worker', event: UsageEvent): UsageLine | undefined {
    if (event.type !== 'assistant/message') return undefined
    const usage = record(record(event.data)?.usage)
    if (usage === undefined) return undefined
    const line: UsageLine = {
      at: new Date(Number.isFinite(event.time) ? event.time : this.host.now().getTime()).toISOString(),
      sessionId, role,
      inputTokens: count(usage, 'inputTokens'),
      outputTokens: count(usage, 'outputTokens'),
      cacheReadTokens: count(usage, 'cacheReadTokens'),
      cacheWriteTokens: count(usage, 'cacheWriteTokens'),
      reasoningTokens: count(usage, 'reasoningTokens'),
    }
    try {
      mkdirSync(this.host.stateDir, { recursive: true, mode: 0o700 })
      appendFileSync(this.path, `${JSON.stringify(line)}\n`, { mode: 0o600 })
    } catch { /* The turn already ran; the ledger is best effort. */ }
    return line
  }

  /** Totals the lines written at or after `since`, in the same shape for every caller. */
  totals(since?: Date): UsageTotals {
    return totalOf(this.lines(since))
  }

  /**
   * Splits a window by Session, most expensive first, so the cost panel can name where the money went instead of only
   * how much left. A worker's Session is told apart from the main one by the role it ran in.
   */
  groups(since?: Date, limit = 5): UsageGroup[] {
    const buckets = new Map<string, UsageLine[]>()
    for (const line of this.lines(since)) {
      const key = `${line.role}:${line.sessionId}`
      const bucket = buckets.get(key)
      if (bucket === undefined) buckets.set(key, [line])
      else bucket.push(line)
    }
    return [...buckets.values()]
      .map(lines => {
        const first = lines[0]!
        return { sessionId: first.sessionId, role: first.role, totals: totalOf(lines) }
      })
      .sort((left, right) => right.totals.estimatedYuan - left.totals.estimatedYuan || right.totals.calls - left.totals.calls)
      .slice(0, limit)
  }

  /** The parsed lines at or after `since`, newest kept within `maxLines`. */
  lines(since?: Date): UsageLine[] {
    if (!existsSync(this.path)) return []
    let text: string
    try { text = readFileSync(this.path, 'utf8') } catch { return [] }
    const all = text.split('\n').flatMap(row => {
      if (row.trim() === '') return []
      try {
        const line = JSON.parse(row) as UsageLine
        return line !== null && typeof line === 'object' && typeof line.at === 'string' ? [line] : []
      } catch { return [] }
    })
    const kept = this.host.maxLines === undefined ? all : all.slice(-this.host.maxLines)
    if (since === undefined) return kept
    const from = since.getTime()
    return kept.filter(line => Date.parse(line.at) >= from)
  }
}
