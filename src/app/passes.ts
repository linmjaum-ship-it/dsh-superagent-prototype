/** Coordinates periodic and on-demand orchestration passes that drive due effects and Engine evaluations. */
import type { Engine, ReceiveResult, Trigger } from '../core/index.ts'
import type { HealthEntry } from '../infra/health.ts'
import type { Effects } from './effects.ts'

export interface PassesHost {
  readonly engine: Pick<Engine, 'receive' | 'evaluateDue'>
  readonly effects: Pick<Effects, 'kick' | 'idle'>
  readonly health: HealthEntry
  readonly lifetime: AbortSignal
  configured(): boolean
  closing(): boolean
  /** Whether any queued effect still waits, so a pass must keep running at the base interval for its retry. */
  waiting?(): boolean
  /** Where to note how long the next unprompted pass waits, so an idle machine's cadence is observable. */
  log?(line: string): void
  /** Advance schedule-driven work that is due, such as a fired Routine; it decides for itself whether anything is due. */
  advance?(): void
}

/** How often a pass runs while work is arriving; a source's own poll calls `request`, so this is the ceiling on latency. */
const BASE_MS = 2000
/** How long a pass may wait while nothing arrives and nothing is queued, so an idle machine does not wake every two seconds. */
const IDLE_MS = 30_000

const now = (): string => new Date().toISOString()

/**
 * Schedules and serializes orchestration passes that kick due `Effects` and advance `Engine` evaluations.
 * `Runtime` manages its lifecycle, while sources, tools, `Settings`, and HTTP routes trigger immediate passes when new work arrives or state changes.
 * Updates the runtime `HealthEntry` when a pass fails and clears the error once a subsequent pass succeeds.
 */
export class Passes {
  private timer?: ReturnType<typeof setTimeout>
  private stopped = false
  /** The delay the next unprompted pass waits: the base while work arrives, doubling to `IDLE_MS` while nothing does. */
  private delay = BASE_MS
  /** Set when something outside the timer asked for a pass, which resets the backoff. */
  private asked = false
  private pumping?: Promise<void>
  private pumpAgain?: Promise<void>
  constructor(private readonly host: PassesHost) {}
  start(): void { if (!this.stopped) this.schedule(BASE_MS) }
  stop(): Promise<unknown> {
    this.stopped = true
    clearTimeout(this.timer)
    return Promise.allSettled([this.pumping, this.pumpAgain])
  }
  receive(trigger: Trigger): ReceiveResult {
    if (this.host.closing()) throw new Error('Orchestrator is stopping')
    const result = this.host.engine.receive(trigger)
    if (result === 'stored') this.request()
    return result
  }
  request(): void {
    this.asked = true
    this.delay = BASE_MS
    // A request is the moment work arrived: run a pass now and leave the next timer at the base interval.
    if (!this.stopped) this.schedule(BASE_MS)
    const { health } = this.host
    this.pump().then(() => {
      if (health.get()?.state !== 'error' || this.host.lifetime.aborted) return
      health.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
    }, (error: unknown) => { health.set({ state: 'error', detail: `A pass failed: ${String(error)}`, at: now() }) })
  }
  /** Arms the next unprompted pass, replacing the timer a request may have shortened. */
  private schedule(delay: number): void {
    clearTimeout(this.timer)
    if (this.stopped) return
    this.timer = setTimeout(() => { void this.tick() }, delay)
  }
  /** One unprompted pass, then arms the next one at the delay the pass earned. */
  private async tick(): Promise<void> {
    if (this.stopped) return
    this.host.advance?.()
    const asked = this.asked
    this.asked = false
    await this.pump().catch(() => { /* request() reports a failed pass through health. */ })
    if (this.stopped) return
    const busy = asked || (this.host.waiting?.() ?? true)
    this.delay = busy ? BASE_MS : Math.min(IDLE_MS, this.delay * 2)
    this.host.log?.(`next pass in ${this.delay}ms`)
    this.schedule(this.delay)
  }
  /** The delay the next unprompted pass waits, for tests and the panel. */
  get interval(): number { return this.delay }
  /** Wait until no pass or effect that can start now is running. */
  async idle(): Promise<void> {
    for (;;) {
      await Promise.allSettled([this.pumping, this.pumpAgain])
      await this.host.effects.idle()
      if (!this.pumping && !this.pumpAgain) return
    }
  }
  /** Run one pass, coalescing concurrent callers into a single follow-up pass. */
  async pump(): Promise<void> {
    // Do not assess, dispatch, or send while waiting for setup; queued work waits for the restart that completes setup.
    if (!this.host.configured() || this.host.closing()) return
    if (!this.pumping) return this.pumping = this.pumpOnce().finally(() => { this.pumping = undefined })
    const next = () => { this.pumpAgain = undefined; return this.pump() }
    return this.pumpAgain ??= this.pumping.then(next, next)
  }
  private async pumpOnce(): Promise<void> {
    this.host.effects.kick()
    if (this.host.closing()) return
    // While processing is paused, the Engine only records the pause on active Evals so they do not expire.
    this.host.engine.evaluateDue()
  }
}
