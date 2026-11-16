import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { usageAlert, UsageLedger, type UsageTotals } from '../src/app/usage.ts'

const dirs: string[] = []
const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'usage-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const now = () => new Date('2026-11-15T00:00:00.000Z')
const message = (usage: unknown, time: number) => ({ type: 'assistant/message', time, data: { usage } })

describe('UsageLedger', () => {
  it('writes one line per model request from the assistant message usage', () => {
    const dir = stateDir()
    const ledger = new UsageLedger({ stateDir: dir, now })
    const line = ledger.observe('orchestrator-a', 'main', message({
      inputTokens: 1200, outputTokens: 300, cacheReadTokens: 4800, cacheWriteTokens: 64, reasoningTokens: 128,
    }, Date.parse('2026-11-15T01:00:00.000Z')))
    expect(line).toMatchObject({ sessionId: 'orchestrator-a', role: 'main', inputTokens: 1200, outputTokens: 300, cacheReadTokens: 4800, cacheWriteTokens: 64, reasoningTokens: 128 })
    expect(line?.at).toBe('2026-11-15T01:00:00.000Z')
    const rows = readFileSync(ledger.path, 'utf8').trim().split('\n')
    expect(rows).toHaveLength(1)
    expect(JSON.parse(rows[0] ?? '')).toEqual(line)
  })

  it('ignores events that carry no usage and events that are not assistant messages', () => {
    const dir = stateDir()
    const ledger = new UsageLedger({ stateDir: dir, now })
    expect(ledger.observe('orchestrator-a', 'main', { type: 'turn/end', time: Date.now(), data: { turn: 1 } })).toBeUndefined()
    expect(ledger.observe('orchestrator-a', 'main', message(undefined, Date.now()))).toBeUndefined()
    expect(existsSync(ledger.path)).toBe(false)
  })

  it('totals a window and reports the cache share of prompt tokens', () => {
    const dir = stateDir()
    const ledger = new UsageLedger({ stateDir: dir, now })
    ledger.observe('orchestrator-a', 'main', message({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 3000 }, Date.parse('2026-11-14T22:00:00.000Z')))
    ledger.observe('worker-b', 'worker', message({ inputTokens: 500, outputTokens: 50, cacheReadTokens: 500 }, Date.parse('2026-11-15T00:30:00.000Z')))
    const all = ledger.totals()
    expect(all).toMatchObject({ calls: 2, inputTokens: 1500, outputTokens: 150, cacheReadTokens: 3500, cacheWriteTokens: 0, reasoningTokens: 0 })
    expect(all.cacheHitRate).toBe(0.7)
    const since = ledger.totals(new Date('2026-11-15T00:00:00.000Z'))
    expect(since).toMatchObject({ calls: 1, inputTokens: 500, cacheReadTokens: 500 })
    expect(since.cacheHitRate).toBe(0.5)
    // List prices: a fresh prompt token costs ten cached ones, and output costs twice a fresh prompt token.
    expect(all.estimatedYuan).toBe(0.00215)
    expect(since.estimatedYuan).toBe(0.00065)
  })

  it('splits a window by Session, most expensive first, and keeps the main one apart from a worker that shares its name', () => {
    const dir = stateDir()
    const ledger = new UsageLedger({ stateDir: dir, now })
    ledger.observe('orchestrator-a', 'main', message({ inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 }, Date.parse('2026-11-14T22:00:00.000Z')))
    ledger.observe('worker-b', 'worker', message({ inputTokens: 100000, outputTokens: 1000, cacheReadTokens: 900000 }, Date.parse('2026-11-14T23:00:00.000Z')))
    ledger.observe('worker-b', 'worker', message({ inputTokens: 1000, outputTokens: 100 }, Date.parse('2026-11-14T23:30:00.000Z')))
    ledger.observe('worker-c', 'worker', message({ inputTokens: 500, outputTokens: 50 }, Date.parse('2026-11-15T01:00:00.000Z')))
    const groups = ledger.groups()
    expect(groups.map(group => [group.role, group.sessionId, group.totals.calls])).toEqual([
      ['worker', 'worker-b', 2], ['main', 'orchestrator-a', 1], ['worker', 'worker-c', 1],
    ])
    // A Session's share adds up to the same total the whole window reports.
    const all = ledger.totals()
    expect(groups.reduce((sum, group) => sum + group.totals.estimatedYuan, 0)).toBeCloseTo(all.estimatedYuan, 6)
    expect(groups[0]?.totals).toMatchObject({ inputTokens: 101000, outputTokens: 1100, cacheReadTokens: 900000 })
    // A window that starts at the midnight of the fixture's clock keeps only the Session that ran after it.
    expect(ledger.groups(new Date('2026-11-15T00:00:00.000Z')).map(group => group.sessionId)).toEqual(['worker-c'])
    expect(ledger.groups(undefined, 1)).toHaveLength(1)
  })

  it('reports nothing while the cache works, and says why when a stable prefix is not reused', () => {
    const totals = (calls: number, cacheHitRate: number): UsageTotals => ({ calls, inputTokens: 100, outputTokens: 10,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, cacheHitRate, estimatedYuan: 0 })
    expect(usageAlert(totals(4, 0.1))).toBeUndefined()
    expect(usageAlert(totals(6, 0.5))).toBeUndefined()
    const alert = usageAlert(totals(6, 0.1))
    expect(alert).toContain('10.0%')
    expect(alert).toContain('6 requests')
  })
})
