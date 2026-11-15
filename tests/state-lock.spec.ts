/** Tests for src/app/state-lock.ts: a start waits out the lock a killed instance left, and a live owner still refuses. */
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockSync } from 'proper-lockfile'
import { afterEach, describe, expect, it } from 'vitest'
import { LOCK_WAIT_MS, lockStateDir } from '../src/app/state-lock.ts'

const dirs: string[] = []
const root = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'state-lock-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const quiet = { onCompromised: () => {} }

describe('lockStateDir', () => {
  it('takes a free state directory at once, and releasing it lets the next start in', async () => {
    const state = join(root(), 'state')
    mkdirSync(state, { recursive: true })
    const release = lockStateDir(state, quiet)
    // A second start is refused while this one holds the lock: the point of the lock is that it is exclusive.
    expect(() => lockSync(state, { stale: 30_000 })).toThrow()
    await release()
    const next = lockStateDir(state, quiet)
    await next()
  })

  it('reclaims a lock left behind by a killed instance instead of failing to mount', async () => {
    const state = join(root(), 'state')
    mkdirSync(state, { recursive: true })
    // A killed process leaves the directory behind with an old timestamp, which is exactly what a stale window detects.
    const lock = `${state}.lock`
    mkdirSync(lock)
    const stale = new Date(Date.now() - 120_000)
    utimesSync(lock, stale, stale)
    const release = lockStateDir(state, quiet)
    await release()
  })

  it('refuses at once while the owner still runs, since only a killed owner is worth the wait', () => {
    const state = join(root(), 'state')
    mkdirSync(state, { recursive: true })
    const release = lockStateDir(state, quiet)
    let pauses = 0
    let error: unknown
    try {
      // The pid file names this process, so the refusal is immediate: waiting could only delay it by the full window.
      lockStateDir(state, { ...quiet, pause: () => { pauses += 1 } })
    } catch (failure) {
      error = failure
    }
    expect(String(error)).toContain('already being held')
    expect(pauses).toBe(0)
    release()
  })

  it('waits out a lock that is not stale yet, and keeps the wait short enough to stay under the boot budget', () => {
    const state = join(root(), 'state')
    mkdirSync(state, { recursive: true })
    const held = lockSync(state, { stale: 600_000 })
    const waits: number[] = []
    let clock = 0
    let error: unknown
    try {
      lockStateDir(state, { ...quiet, now: () => clock, pause: (ms: number) => { clock += ms }, onWait: waited => { waits.push(waited) } })
    } catch (failure) {
      error = failure
    }
    // A live owner never gives the lock up, so the start ends in a refusal rather than in two writers on one database.
    expect(String(error)).toContain('already being held')
    expect(waits.length).toBeGreaterThan(1)
    expect(waits.at(-1)).toBe(LOCK_WAIT_MS)
    expect(clock).toBe(LOCK_WAIT_MS)
    held()
  })
})
