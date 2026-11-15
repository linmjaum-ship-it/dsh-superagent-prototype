import { expect, it } from 'vitest'
import { WakeProbe, type WakeEvent } from '../src/app/wake-probe.ts'

const epoch = Date.parse('2026-11-15T08:00:00Z')
const master = 'orchestrator-probe-test'
const event = (type: string, seq: number, data: unknown): WakeEvent => ({ type, seq, time: epoch + seq * 1000, data })
const reached = (seq: number, turn = 1): WakeEvent => event('assistant/message', seq, { turn, step: 1, stream: [], message: { source: { kind: 'model', provider: 'provider-a', model: 'model-a' } } })

it('reports a wake the host refused before any model request', () => {
  const probe = new WakeProbe(master)
  expect(probe.observe(master, event('turn/start', 1, { turn: 1 }))).toBeUndefined()
  expect(probe.observe(master, event('turn/end', 2, { turn: 1, reason: { kind: 'blocked' } }))).toBe('blocked')
  expect(probe.blockedWakes).toBe(1)
  expect(probe.detail).toContain('1 consecutive wake(s) ended without a model request')
  expect(probe.detail).toContain('2026-11-15T08:00:02.000Z')

  expect(probe.observe(master, event('turn/start', 3, { turn: 2 }))).toBeUndefined()
  expect(probe.observe(master, event('turn/end', 4, { turn: 2, reason: { kind: 'blocked' } }))).toBe('blocked')
  expect(probe.blockedWakes).toBe(2)
})

it('clears the count once a wake reaches the model', () => {
  const probe = new WakeProbe(master)
  probe.observe(master, event('turn/start', 1, { turn: 1 }))
  probe.observe(master, event('turn/end', 2, { turn: 1, reason: { kind: 'blocked' } }))
  expect(probe.blockedWakes).toBe(1)

  expect(probe.observe(master, event('turn/start', 3, { turn: 2 }))).toBeUndefined()
  expect(probe.observe(master, reached(4, 2))).toBeUndefined()
  expect(probe.observe(master, event('turn/end', 5, { turn: 2, reason: { kind: 'completed' } }))).toBe('recovered')
  expect(probe.blockedWakes).toBe(0)
  expect(probe.detail).toBeUndefined()
})

it('does not count a turn that reached the model but was blocked afterwards, or another Session', () => {
  const probe = new WakeProbe(master)
  probe.observe(master, event('turn/start', 1, { turn: 1 }))
  probe.observe(master, reached(2, 1))
  expect(probe.observe(master, event('turn/end', 3, { turn: 1, reason: { kind: 'blocked' } }))).toBe('recovered')
  expect(probe.blockedWakes).toBe(0)

  expect(probe.observe('worker-other', event('turn/start', 4, { turn: 1 }))).toBeUndefined()
  expect(probe.observe('worker-other', event('turn/end', 5, { turn: 1, reason: { kind: 'blocked' } }))).toBeUndefined()
  expect(probe.blockedWakes).toBe(0)
})

it('ignores events that arrive out of order', () => {
  const probe = new WakeProbe(master)
  probe.observe(master, event('turn/start', 5, { turn: 1 }))
  expect(probe.observe(master, event('turn/end', 4, { turn: 1, reason: { kind: 'blocked' } }))).toBeUndefined()
  expect(probe.blockedWakes).toBe(0)
})
