/**
 * Golden cases: the end-to-end promises a manual run used to prove, replayed deterministically against fake Sources, a
 * fake GitHub CLI and a fake DSH host, so a regression that breaks one of them turns at least one case red.
 *
 * | Case | Promise it replays |
 * | --- | --- |
 * | G1 | A Feishu mention reaches Eval and becomes a candidate on the main Session, and opens no Ticket by itself. |
 * | G2 | Accepting a candidate opens a Ticket with its worker Session and a durable fact card (T09). |
 * | G3 | A worker report reaches the main Session and ends its Ticket, which is the Worker to PR leg without a live PR. |
 * | G4 | The command gate refuses a blocked command before a worker runs it (T06). |
 * | G5 | A main Session DSH archived is repaired before its next wake (T02). |
 * | G6 | A due Routine fires one inferred trigger into Eval, moves its schedule, and opens no Ticket (T11). |
 * | G7 | An idle machine backs off to the long pass interval, and a request returns it to the base (T10). |
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { feishu, startRuntime, type Host } from './fixtures/host.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { Commands } from '../src/infra/commands.ts'
import { SelfHeal, type ArchiveRegistry } from '../src/app/self-heal.ts'
import { Passes } from '../src/app/passes.ts'
import { FACTS_MARKER, renderFacts, type TicketFacts } from '../src/app/facts.ts'

let h: Host | undefined
const dirs: string[] = []
const stateDir = (): string => { const dir = mkdtempSync(join(tmpdir(), 'golden-')); dirs.push(dir); return dir }
afterEach(async () => {
  await h?.stop(); h = undefined
  vi.useRealTimers()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('golden cases', () => {
  it('G1 a Feishu mention reaches Eval and becomes a candidate, opening no Ticket by itself', async () => {
    h = await startRuntime()
    const mention = feishu('1', '@bot 修一下回归')
    h.runtime.receive(mention)
    await h.runtime.idle()
    expect(h.candidates()).toEqual([mention.id])
    expect(h.runtime.store.tickets.list()).toEqual([])
  })

  it('G2 accepting a candidate opens a Ticket with its worker Session and a durable fact card', async () => {
    h = await startRuntime()
    const { ticket, sessionId } = await h.acceptedTicket(feishu('2', '@bot 修一下回归'))
    expect(ticket.execution?.name).toMatch(/^fix-regression/)
    expect(h.tools.has(sessionId)).toBe(true)
    const card = await vi.waitFor(async () => {
      const facts = await h!.runtime.facts.read(ticket.id)
      if (!facts) throw new Error('the fact card was not written yet')
      return facts
    }) as TicketFacts
    expect(card.ticketId).toBe(ticket.id)
    expect(card.repository).toBe('acme/widgets')
    expect(renderFacts(card)).toContain(FACTS_MARKER)
  })

  it('G3 a worker report reaches the main Session and ends its Ticket', async () => {
    h = await startRuntime()
    const { ticket, sessionId } = await h.acceptedTicket(feishu('3', '@bot 修一下回归'))
    h.deliveries.mockClear()
    await h.runTool(sessionId, 'orchestrator_report', { state: 'ready', summary: '回归修好了' })
    await h.runtime.idle()
    expect(h.runtime.store.tickets.get(ticket.id)!.ended).toBeDefined()
    expect(h.relays(h.runtime.masterId).map(item => item.kind)).toEqual(['worker_report'])
  })

  it('G4 the command gate refuses a blocked command before a worker runs it', async () => {
    const commands = new Commands(() => testDeployment(), {}, new AbortController().signal, () => ['rm'])
    await expect(commands.run('C:\\Windows\\System32\\rm.exe', ['-rf', 'build'])).rejects.toThrow('rm is blocked in this installation')
    await expect(commands.run('RM.CMD', [])).rejects.toThrow('rm is blocked in this installation')
  })

  it('G5 a main Session DSH archived is repaired before its next wake', async () => {
    const dir = stateDir()
    chmodSync(dir, 0o700)
    const ids = ['orchestrator-golden', 'other']
    const workspace: ArchiveRegistry = {
      get archivedSessionIds() { return ids },
      async unarchiveSession(id: string) { ids.splice(ids.indexOf(id), 1) },
    }
    const heal = new SelfHeal({ masterId: 'orchestrator-golden', stateDir: dir, workspace, enabled: true,
      now: () => new Date('2026-11-15T00:00:00.000Z') })
    await expect(heal.heal('wake ended without a model request')).resolves.toBe('unarchived')
    expect(ids).toEqual(['other'])
  })

  it('G6 a due Routine fires one inferred trigger into Eval, moves its schedule, and opens no Ticket', async () => {
    h = await startRuntime()
    const routine = h.runtime.routines.save({ name: '巡检', cron: '0 3 * * *', prompt: '检查今天打开的 PR' })
    const later = new Date(Date.parse(routine.nextAt) + 24 * 3600 * 1000)
    expect(h.runtime.routines.advance(later)).toEqual([routine.id])
    await h.runtime.idle()
    const fired = h.candidates() as string[]
    expect(fired).toHaveLength(1)
    expect(h.runtime.store.triggers.get(fired[0]!)).toMatchObject({ source: 'routine', human: false, meta: { routine: routine.id } })
    expect(h.runtime.store.triggers.disposition(fired[0]!)).toBeDefined()
    expect(h.runtime.store.tickets.list()).toEqual([])
    expect(Date.parse(h.runtime.store.routines.get(routine.id)!.nextAt)).toBeGreaterThan(later.getTime())
  })

  it('G7 an idle machine backs off to the long interval, and a request returns it to the base', async () => {
    vi.useFakeTimers()
    const passes = new Passes({
      engine: { receive: () => 'stored', evaluateDue: () => {} } as never,
      effects: { kick: () => {}, idle: async () => {} },
      health: { get: () => undefined, set: () => {}, release: () => {} },
      lifetime: new AbortController().signal, configured: () => true, closing: () => false, waiting: () => false,
    })
    passes.start()
    const seen: number[] = []
    for (const wait of [2000, 4000, 8000, 16000, 30000]) {
      await vi.advanceTimersByTimeAsync(wait)
      seen.push(passes.interval)
    }
    expect(seen).toEqual([4000, 8000, 16000, 30000, 30000])
    passes.request()
    expect(passes.interval).toBe(2000)
    await passes.stop()
  })
})
