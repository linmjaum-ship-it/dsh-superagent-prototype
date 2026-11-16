/**
 * Detects wakes of the main Session that ended before any model request. A session DSH refuses to resume — as when its id sits
 * in the workspace archive — ends every turn as `blocked` with no `assistant/message`, so the orchestrator looks alive while
 * accepting nothing. Reading that verdict from the event stream costs no model request.
 */

/** One ordered session event, shaped as `Sessions` receives it. */
export interface WakeEvent { readonly type: string; readonly seq: number; readonly time: number; readonly data: unknown }

interface Turn { turn: number; model: boolean }

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const ordinal = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

/**
 * Tracks whether the main Session's wakes reach the model, by the turns it ended as `blocked` with no model message.
 * `Sessions` feeds it the main Session's events and mirrors the verdict into the `wake` `HealthEntry`; it never calls a model,
 * and a turn that reached the model clears the count, so the entry returns to ready on its own.
 */
export class WakeProbe {
  private seq = -1
  private turn: Turn | undefined
  private blocked = 0
  private lastBlockedAt: string | undefined
  constructor(private readonly sessionId: string) {}
  /** Consecutive wakes the host refused before a model request; zero once a turn reaches the model. */
  get blockedWakes(): number { return this.blocked }
  /** The last refusal, worded for a health detail; undefined once a turn reaches the model. */
  get detail(): string | undefined {
    return this.lastBlockedAt === undefined ? undefined
      : `${this.blocked} consecutive wake(s) ended without a model request; last at ${this.lastBlockedAt}`
  }
  /**
   * Observe one event. Returns `blocked` when a turn ended refused before any model request, `recovered` when a turn reached
   * the model, and undefined for everything else, so the caller writes health only on a verdict change worth reporting.
   */
  observe(sessionId: string, event: WakeEvent): 'blocked' | 'recovered' | undefined {
    if (sessionId !== this.sessionId) return undefined
    if (!ordinal(event.seq) || !Number.isFinite(event.time) || event.time < 0) return undefined
    if (event.seq <= this.seq) return undefined
    this.seq = event.seq
    const data = record(event.data)
    if (!data || !ordinal(data.turn)) return undefined
    if (event.type === 'turn/start') { this.turn = { turn: data.turn, model: false }; return undefined }
    const turn = this.turn
    if (!turn || turn.turn !== data.turn) return undefined
    if (event.type === 'assistant/message') {
      if (record(record(data.message)?.source)?.kind === 'model') turn.model = true
      return undefined
    }
    if (event.type !== 'turn/end') return undefined
    const reason = record(data.reason)
    this.turn = undefined
    if (!turn.model && reason?.kind === 'blocked') {
      this.blocked += 1
      this.lastBlockedAt = new Date(event.time).toISOString()
      return 'blocked'
    }
    if (turn.model) { this.blocked = 0; this.lastBlockedAt = undefined; return 'recovered' }
    return undefined
  }
}
