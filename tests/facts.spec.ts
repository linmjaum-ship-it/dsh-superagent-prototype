import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Ticket } from '../src/core/model.ts'
import { FACTS_MARKER, FactCards, factsOf, parseFacts, pullRequestOf, renderFacts, serializeFacts } from '../src/app/facts.ts'

const dirs: string[] = []
const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'facts-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const at = '2026-11-15T03:00:00.000Z'
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({
  id: 'ticket-1',
  title: 'Fix the flaky login test',
  decisionId: 'decision-1',
  mandate: { strength: 'normal', policyVersion: 'p1', actor: { kind: 'person', id: 'u1' }, scope: 'the login test only',
    basis: { via: 'listed', rules: ['do not touch the release branch'] } },
  channels: [], assignments: [], inputs: [], undelivered: [],
  follows: [{ thread: 'github:12', own: true }],
  createdAt: at, updatedAt: at, origin: { triggerId: 'trigger-1', triggerIds: ['trigger-1'] },
  ...overrides,
} as unknown as Ticket)

describe('fact cards', () => {
  it('renders the block a compacted Session reads, with the ticket id and pull request', () => {
    const facts = factsOf(ticket(), 'nielsensilje87-sketch/superagent-handoff-test', at)
    const card = renderFacts(facts)
    expect(card.startsWith(FACTS_MARKER)).toBe(true)
    expect(card).toContain('ticket: ticket-1')
    expect(card).toContain('pull request: #12')
    expect(card).toContain('- do not touch the release branch')
    expect(card).toContain('scope: the login test only')
  })

  it('round-trips a card through its file form, so a restarted host renders the same block', () => {
    const facts = factsOf(ticket(), 'o/r', at)
    expect(parseFacts(serializeFacts(facts))).toEqual(facts)
  })

  it('keeps the pull request of the ticket, and ignores a follow it only watches', () => {
    expect(pullRequestOf({ follows: [{ thread: 'github:9', own: false }, { thread: 'github:12', own: true }] })).toBe(12)
    expect(pullRequestOf({ follows: [{ thread: 'feishu:c1', own: true }] })).toBeUndefined()
    expect(pullRequestOf({})).toBeUndefined()
  })

  it('writes one file per ticket under the state directory and serves it to the prompt without a read', async () => {
    const dir = root()
    const cards = new FactCards(dir)
    const facts = factsOf(ticket(), 'o/r', at)
    await cards.write(facts)
    expect(cards.peek('ticket-1')).toEqual(facts)
    expect(await cards.read('ticket-1')).toEqual(facts)
    expect(await cards.read('ticket-2')).toBeUndefined()
    const fresh = new FactCards(dir)
    expect(await fresh.read('ticket-1')).toEqual(facts)
  })

  it('serves a card to the prompt before its file exists, because a worker asks in the tick that creates it', async () => {
    const dir = root()
    const cards = new FactCards(dir)
    const facts = factsOf(ticket(), 'o/r', at)
    cards.remember(facts)
    expect(cards.peek('ticket-1')).toEqual(facts)
    expect(renderFacts(cards.peek('ticket-1')!)).toContain(FACTS_MARKER)
    expect(await new FactCards(dir).read('ticket-1')).toBeUndefined()
  })

  it('reads a card off the disk for a host that restarted, before any request has written one', async () => {
    const dir = root()
    const facts = factsOf(ticket(), 'o/r', at)
    await new FactCards(dir).write(facts)
    const restarted = new FactCards(dir)
    expect(restarted.peek('ticket-1')).toEqual(facts)
    expect(renderFacts(restarted.peek('ticket-1')!)).toContain(FACTS_MARKER)
  })

  it('truncates a runaway card rather than paying for it on every request', () => {
    const facts = factsOf(ticket(), 'o/r', at)
    const card = renderFacts({ ...facts, title: 't'.repeat(2_500), acceptance: Array.from({ length: 40 }, (_, index) => `criterion ${index} ${'x'.repeat(260)}`) })
    expect(card).toContain('(card truncated)')
    expect(card.length).toBeLessThanOrEqual(2_100)
  })

  it('reads a card an operator edited by hand, and refuses a file that is not one', () => {
    const hand = 'ticket: ticket-7\ntitle: done\nrepository: o/r\nstrength: normal\nscope: all\nupdated: 2026-11-15T03:00:00.000Z\nacceptance:\n  - tests pass\n'
    expect(parseFacts(hand)).toMatchObject({ ticketId: 'ticket-7', acceptance: ['tests pass'], pullRequest: undefined })
    expect(parseFacts('nothing useful here')).toBeUndefined()
  })
})
