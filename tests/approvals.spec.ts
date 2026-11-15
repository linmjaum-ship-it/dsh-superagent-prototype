import { describe, expect, it } from 'vitest'
import { APPROVAL_REFUSAL_MS, APPROVAL_REMIND_MS, APPROVAL_TIMEOUT_MS, Approvals, approvalAnswer, approvalCard, type ApprovalRequest, type ApprovalStore } from '../src/app/approvals.ts'
import { cardAction, cardRetry, handleCardLine, type CardConsumerHost } from '../src/app/card-consume.ts'

const at = new Date('2026-11-15T03:00:00.000Z')
const later = (ms: number): Date => new Date(at.getTime() + ms)

/** The approvals on a Map, which is what the store's own repository behaves like from their side. */
const memory = (): ApprovalStore & { rows: Map<string, ApprovalRequest> } => {
  const rows = new Map<string, ApprovalRequest>()
  return { rows, get: id => rows.get(id), save: request => { rows.set(request.id, request) }, list: () => [...rows.values()] }
}
const ask = { ticketId: 'ticket-1', rule: 'force_push', command: 'git push --force origin main', chatId: 'oc_team' }

describe('approvals', () => {
  it('asks once per ticket and rule, and stops granting anything ten minutes after the question', () => {
    const store = memory()
    const approvals = new Approvals(store, () => at)
    const first = approvals.ask(ask)
    expect(first.state).toBe('pending')
    expect(first.expiresAt).toBe(new Date(at.getTime() + APPROVAL_TIMEOUT_MS).toISOString())
    expect(approvals.ask(ask)).toBe(first)
    expect(approvals.waiting()).toHaveLength(1)
    expect(approvals.waiting(later(APPROVAL_TIMEOUT_MS + 1))).toHaveLength(0)
  })

  it('runs the approved command once, and only for the ticket and rule the card named', () => {
    const store = memory()
    const approvals = new Approvals(store, () => at)
    const request = approvals.ask(ask)
    expect(approvals.decide(request.id, 'approve', 'ou_actor', 'card')).toMatchObject({ state: 'approved', decidedBy: 'ou_actor' })
    expect(approvals.allow('ticket-2', 'force_push')).toBeUndefined()
    expect(approvals.allow('ticket-1', 'repo_delete')).toBeUndefined()
    expect(approvals.allow('ticket-1', 'force_push')?.state).toBe('used')
    expect(approvals.allow('ticket-1', 'force_push')).toBeUndefined()
  })

  it('turns a refusal, a second answer, and a late answer into records the worker reads as refusals', () => {
    const store = memory()
    const approvals = new Approvals(store, () => at)
    const request = approvals.ask(ask)
    expect(approvals.decide(request.id, 'reject', 'ou_actor', 'card')).toMatchObject({ state: 'rejected' })
    expect(approvals.decide(request.id, 'approve', 'ou_actor', 'card')).toBeUndefined()
    const late = approvals.ask({ ...ask, rule: 'repo_delete' })
    expect(approvals.decide(late.id, 'approve', 'ou_actor', 'panel', later(APPROVAL_TIMEOUT_MS + 1))).toMatchObject(
      { state: 'expired', decidedBy: 'ou_actor', decidedVia: 'panel' })
    expect(approvals.allow('ticket-1', 'repo_delete')).toBeUndefined()
  })

  it('lists what it asked newest first, and tells an observer how many still wait and for how long', () => {
    const store = memory()
    const approvals = new Approvals(store, () => at)
    const first = approvals.ask(ask)
    const second = approvals.ask({ ...ask, rule: 'repo_delete', command: 'gh repo delete acme/widgets --yes' }, later(60_000))
    expect(approvals.list().map(request => request.id)).toEqual([second.id, first.id])
    expect(approvals.summary(later(120_000))).toEqual({ waiting: 2, oldestMinutes: 2 })
    approvals.decide(second.id, 'approve', 'ou_actor', 'panel', later(120_000))
    expect(approvals.summary(later(180_000))).toEqual({ waiting: 1, oldestMinutes: 3 })
    expect(approvals.summary(later(APPROVAL_TIMEOUT_MS + 1))).toEqual({ waiting: 0, oldestMinutes: 0 })
  })

  it('keeps a refusal in force for a while, so a worker told no stops asking instead of drawing card after card', () => {
    const store = memory()
    const approvals = new Approvals(store, () => at)
    const request = approvals.ask(ask)
    expect(approvals.refused('ticket-1', 'force_push')).toBeUndefined()
    approvals.decide(request.id, 'reject', 'ou_actor', 'card', later(60_000))
    expect(approvals.refused('ticket-1', 'force_push', later(120_000))?.id).toBe(request.id)
    expect(approvals.refused('ticket-2', 'force_push', later(120_000))).toBeUndefined()
    expect(approvals.refused('ticket-1', 'repo_delete', later(120_000))).toBeUndefined()
    expect(approvals.refused('ticket-1', 'force_push', later(60_000 + APPROVAL_REFUSAL_MS))).toBeUndefined()
    expect(approvals.refused('ticket-1', 'force_push', later(60_000 + APPROVAL_REFUSAL_MS - 1))?.state).toBe('rejected')
  })

  it('flags only what is close to lapsing, so a thread hears once before the deadline instead of after it', () => {
    const store = memory()
    const approvals = new Approvals(store, () => at)
    const request = approvals.ask(ask)
    expect(approvals.expiring(later(0))).toHaveLength(0)
    expect(approvals.expiring(later(APPROVAL_TIMEOUT_MS - APPROVAL_REMIND_MS - 1))).toHaveLength(0)
    expect(approvals.expiring(later(APPROVAL_TIMEOUT_MS - APPROVAL_REMIND_MS)).map(item => item.id)).toEqual([request.id])
    approvals.decide(request.id, 'approve', 'ou_actor', 'card', later(60_000))
    expect(approvals.expiring(later(APPROVAL_TIMEOUT_MS - APPROVAL_REMIND_MS))).toHaveLength(0)
  })

  it('counts how the questions ended, so the panel can show that people answer instead of only what is open', () => {
    const store = memory()
    const approvals = new Approvals(store, () => at)
    const one = approvals.ask(ask)
    const two = approvals.ask({ ...ask, rule: 'repo_delete' })
    const three = approvals.ask({ ...ask, ticketId: 'ticket-3' })
    expect(approvals.tally(later(0))).toEqual({ waiting: 3, approved: 0, rejected: 0, expired: 0, used: 0 })
    approvals.decide(one.id, 'approve', 'ou_actor', 'card', later(60_000))
    approvals.decide(two.id, 'reject', 'ou_actor', 'card', later(60_000))
    approvals.advance(later(APPROVAL_TIMEOUT_MS + 1))
    // One was approved but nobody spent it, so it lapsed like the unanswered one and the rejection is all that stands.
    expect(approvals.tally(later(APPROVAL_TIMEOUT_MS + 1))).toEqual({ waiting: 0, approved: 0, rejected: 1, expired: 2, used: 0 })
    expect(approvals.waiting(later(APPROVAL_TIMEOUT_MS + 1))).toHaveLength(0)
  })

  it('retires what nobody answered, so a restart cannot resurrect an old approval', () => {
    const store = memory()
    const approvals = new Approvals(store, () => at)
    approvals.ask(ask)
    const second = approvals.ask({ ...ask, rule: 'repo_delete' })
    approvals.decide(second.id, 'approve', 'ou_actor', 'card')
    expect(approvals.advance(later(60_000))).toBe(0)
    expect(approvals.advance(later(APPROVAL_TIMEOUT_MS + 1))).toBe(2)
    expect(approvals.allow('ticket-1', 'repo_delete')).toBeUndefined()
  })
})

describe('approval card', () => {
  const request: ApprovalRequest = { id: 'approval:ticket-1:force_push:2026-11-15T03:00', ticketId: 'ticket-1', rule: 'force_push',
    command: 'git push --force origin main', chatId: 'oc_team', askedAt: at.toISOString(),
    expiresAt: new Date(at.getTime() + APPROVAL_TIMEOUT_MS).toISOString(), state: 'pending' }

  it('carries both answers as the button values the callback reads back', () => {
    const card = approvalCard(request)
    const parsed = JSON.parse(card) as { elements: { actions?: { value: unknown }[] }[] }
    const values = parsed.elements.flatMap(element => element.actions ?? []).map(action => action.value)
    expect(values).toEqual([{ approval: request.id, answer: 'approve' }, { approval: request.id, answer: 'reject' }])
    expect(card).toContain(request.ticketId)
    expect(card).toContain('git push --force origin main')
    expect(card).toContain('自动放弃')
  })

  it('reads only a value that names an approval and an answer this plugin sent', () => {
    expect(approvalAnswer({ action_value: JSON.stringify({ approval: 'a1', answer: 'approve' }) })).toEqual({ approval: 'a1', answer: 'approve' })
    expect(approvalAnswer({ action_value: JSON.stringify({ approval: 'a1', answer: 'maybe' }) })).toBeUndefined()
    expect(approvalAnswer({ action_value: JSON.stringify({ answer: 'approve' }) })).toBeUndefined()
    expect(approvalAnswer({ action_value: '{not json' })).toBeUndefined()
    expect(approvalAnswer({})).toBeUndefined()
  })
})

describe('card consumer', () => {
  const host = (rows: ApprovalStore): CardConsumerHost & { lines: string[] } => {
    const lines: string[] = []
    return { approvals: new Approvals(rows, () => at), cli: 'lark-cli', lines, log: line => { lines.push(line) } }
  }

  it('answers the approval a callback line names, and ignores a card this plugin did not send', async () => {
    const store = memory()
    const consumer = host(store)
    const request = consumer.approvals.ask(ask)
    const line = JSON.stringify({ chat_id: 'oc_team', message_id: 'om_1', operator_id: 'ou_actor',
      action_value: JSON.stringify({ approval: request.id, answer: 'approve' }) })
    expect(await handleCardLine(line, consumer)).toMatchObject({ state: 'approved' })
    expect(consumer.approvals.allow('ticket-1', 'force_push')).toBeDefined()
    expect(await handleCardLine(JSON.stringify({ chat_id: 'oc_team', action_value: '{}' }), consumer)).toBeUndefined()
    expect(await handleCardLine('not json', consumer)).toBeUndefined()
  })

  it('logs an answer for an approval that is no longer pending, instead of granting it', async () => {
    const store = memory()
    const consumer = host(store)
    expect(await handleCardLine(JSON.stringify({ chat_id: 'oc_team', operator_id: 'ou_actor',
      action_value: JSON.stringify({ approval: 'approval:gone', answer: 'approve' }) }), consumer)).toBeUndefined()
    expect(consumer.lines.join(' ')).toContain('not pending')
  })

  it('names the chat and the person a callback came from, and backoff matches the event consumer', () => {
    expect(cardAction({ chat_id: 'oc_team', message_id: 'om_1', user_id: 'ou_actor' })).toMatchObject({ chatId: 'oc_team', messageId: 'om_1', operator: 'ou_actor' })
    expect(cardAction({ message_id: 'om_1' })).toBeUndefined()
    expect(cardRetry(undefined, 0)).toBe(1_000)
    expect(cardRetry(1_000, 1_000)).toBe(2_000)
    expect(cardRetry(60_000, 1_000)).toBe(60_000)
    expect(cardRetry(30_000, 60_000)).toBe(1_000)
  })
})
