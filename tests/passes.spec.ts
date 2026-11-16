import { afterEach, describe, expect, it, vi } from 'vitest'
import { Passes } from '../src/app/passes.ts'

const health = {
  value: undefined as undefined | { state: string; detail: string },
  get() { return this.value },
  set(entry: { state: string; detail: string }) { this.value = entry },
}

const passesFor = (waiting: boolean) => new Passes({
  engine: { receive: () => 'stored', evaluateDue: () => {} },
  effects: { kick: () => {}, idle: async () => {} },
  health: health as never,
  lifetime: new AbortController().signal,
  configured: () => true,
  closing: () => false,
  waiting: () => waiting,
} as never)

afterEach(() => { vi.useRealTimers() })

describe('Passes', () => {
  it('backs off to thirty seconds while nothing arrives and nothing waits', async () => {
    vi.useFakeTimers()
    const passes = passesFor(false)
    passes.start()
    expect(passes.interval).toBe(2000)
    for (const step of [2000, 4000, 8000, 16000, 30000]) {
      await vi.advanceTimersByTimeAsync(step)
    }
    expect(passes.interval).toBe(30_000)
  })

  it('keeps the base interval while a queued effect still waits', async () => {
    vi.useFakeTimers()
    const passes = passesFor(true)
    passes.start()
    await vi.advanceTimersByTimeAsync(2000)
    expect(passes.interval).toBe(2000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(passes.interval).toBe(2000)
  })

  it('returns to the base interval as soon as work arrives', async () => {
    vi.useFakeTimers()
    const passes = passesFor(false)
    passes.start()
    for (const step of [2000, 4000, 8000, 16000, 30000]) await vi.advanceTimersByTimeAsync(step)
    expect(passes.interval).toBe(30_000)
    passes.request()
    expect(passes.interval).toBe(2000)
    // The pass a request triggers counts as busy, so the pass after it stays at the base interval.
    await vi.advanceTimersByTimeAsync(2000)
    expect(passes.interval).toBe(2000)
    await vi.advanceTimersByTimeAsync(2000)
    expect(passes.interval).toBe(4000)
  })
})
