import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Store } from '../src/app/store.ts'
import { Routines, nextRun, parseCron } from '../src/app/routines.ts'
import type { Trigger } from '../src/core/model.ts'

const dirs: string[] = []
const opened: Store[] = []
afterEach(() => {
  for (const store of opened.splice(0)) store.close()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function database(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'routines-'))
  dirs.push(dir)
  const store = new Store(join(dir, 'db.sqlite'))
  opened.push(store)
  return store
}

const local = (text: string): Date => new Date(text)

describe('cron expressions', () => {
  it('reads the five fields, a list, a range, and a step', () => {
    const schedule = parseCron('*/15 9-11 1,15 * 1-5')
    expect([...schedule.minutes]).toEqual([0, 15, 30, 45])
    expect([...schedule.hours]).toEqual([9, 10, 11])
    expect([...schedule.days]).toEqual([1, 15])
    expect(schedule.anyDay).toBe(false)
    expect(schedule.anyWeekday).toBe(false)
  })

  it('accepts the nicknames cron ships with', () => {
    expect([...parseCron('@daily').minutes]).toEqual([0])
    expect([...parseCron('@weekly').weekdays]).toEqual([0])
    expect([...parseCron('@monthly').days]).toEqual([1])
  })

  it('refuses an expression whose field count, value, or step is wrong', () => {
    expect(() => parseCron('0 9 * *')).toThrow(/expected five fields/)
    expect(() => parseCron('0 24 * * *')).toThrow(/outside the hour range/)
    expect(() => parseCron('0 9 * * */0')).toThrow(/positive integer/)
  })

  it('finds the next minute the expression names', () => {
    expect(nextRun('0 9 * * *', local('2026-11-15T08:30:00')).toISOString()).toBe(local('2026-11-15T09:00:00').toISOString())
    expect(nextRun('*/15 * * * *', local('2026-11-15T08:01:00')).toISOString()).toBe(local('2026-11-15T08:15:00').toISOString())
    // A day field and a weekday field both named match on either, so the 16th (a Monday) fires although it is not the 20th.
    expect(nextRun('0 9 20 * 1', local('2026-11-15T10:00:00')).toISOString()).toBe(local('2026-11-16T09:00:00').toISOString())
  })

  it('refuses a schedule that never fires', () => {
    expect(() => nextRun('0 0 31 2 *', local('2026-11-15T00:00:00'))).toThrow(/never fires within a year/)
  })
})

describe('routines', () => {
  const saved = (routines: Routines, at: Date) => routines.save({ name: 'Morning review', cron: '0 9 * * *', prompt: 'Review the open pull requests' })

  it('saves a routine with the next run it will keep', () => {
    const routines = new Routines(database(), { receive: () => 'stored' })
    const routine = saved(routines, local('2026-11-15T08:00:00'))
    expect(routine.cron).toBe('0 9 * * *')
    expect(routine.enabled).toBe(true)
    expect(routine.nextAt).toBeDefined()
    expect(routines.list()).toHaveLength(1)
  })

  it('fires a due routine once as an inferred trigger and moves it to its next run', () => {
    const received: Trigger[] = []
    const store = database()
    const routines = new Routines(store, { receive: trigger => { received.push(trigger); return 'stored' } })
    const routine = saved(routines, local('2026-11-15T08:00:00'))
    store.routines.save({ ...routine, nextAt: local('2026-11-15T09:00:00').toISOString() })

    expect(routines.advance(local('2026-11-15T08:59:00'))).toEqual([])
    expect(routines.advance(local('2026-11-15T09:00:00'))).toEqual([routine.id])
    expect(received).toHaveLength(1)
    const trigger = received[0]!
    expect(trigger.source).toBe('routine')
    expect(trigger.human).toBe(false)
    expect(trigger.text).toBe('Review the open pull requests')
    expect(trigger.meta).toEqual({ routine: routine.id })
    expect(trigger.threads).toEqual([{ source: 'routine', id: routine.id }])
    expect(store.routines.get(routine.id)?.lastAt).toBe(local('2026-11-15T09:00:00').toISOString())
    expect(store.routines.get(routine.id)?.nextAt).toBe(local('2026-11-16T09:00:00').toISOString())
    // The same minute does not fire twice.
    expect(routines.advance(local('2026-11-15T09:00:00'))).toEqual([])
  })

  it('leaves a disabled routine scheduled but never fires it', () => {
    const received: Trigger[] = []
    const store = database()
    const routines = new Routines(store, { receive: trigger => { received.push(trigger); return 'stored' } })
    const routine = routines.save({ name: 'Paused review', cron: '@daily', prompt: 'Review', enabled: false })
    expect(routines.advance(local('2027-01-01T00:00:00'))).toEqual([])
    expect(received).toEqual([])
    expect(store.routines.get(routine.id)?.enabled).toBe(false)
  })

  it('keeps the schedule when a trigger cannot enter, and says so', () => {
    const lines: string[] = []
    const store = database()
    const routines = new Routines(store, { receive: () => { throw new Error('Orchestrator is stopping') }, log: line => { lines.push(line) } })
    const routine = saved(routines, local('2026-11-15T08:00:00'))
    store.routines.save({ ...routine, nextAt: local('2026-11-15T09:00:00').toISOString() })
    expect(routines.advance(local('2026-11-15T09:00:00'))).toEqual([routine.id])
    expect(lines.join('\n')).toContain('could not fire: Error: Orchestrator is stopping')
    expect(store.routines.get(routine.id)?.nextAt).toBe(local('2026-11-16T09:00:00').toISOString())
  })

  it('removes a routine the operator no longer wants', () => {
    const routines = new Routines(database(), { receive: () => 'stored' })
    const routine = routines.save({ name: 'Weekly review', cron: '@weekly', prompt: 'Review' })
    expect(routines.remove(routine.id)).toBe(true)
    expect(routines.list()).toEqual([])
  })

  it('refuses a routine without a name, a prompt, or a schedule', () => {
    const routines = new Routines(database(), { receive: () => 'stored' })
    expect(() => routines.save({ name: ' ', cron: '@daily', prompt: 'Review' })).toThrow(/needs a name/)
    expect(() => routines.save({ name: 'Review', cron: '@daily', prompt: ' ' })).toThrow(/needs a prompt/)
    expect(() => routines.save({ name: 'Review', cron: '0 9 * *', prompt: 'Review' })).toThrow(/expected five fields/)
  })
})
