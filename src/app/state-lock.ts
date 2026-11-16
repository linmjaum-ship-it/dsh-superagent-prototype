/**
 * The state-directory lock: a killed instance leaves its lock behind, and the next start has to wait that window out
 * instead of failing to mount at all. A refused lock is therefore retried until the crashed owner's lock goes stale.
 * Who holds it is written beside the lock, so a live owner is still refused at once instead of costing the wait.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { lockSync } from 'proper-lockfile'

/** A lock whose owner died is reclaimed once it is older than this; a live owner refreshes its timestamp every half. */
export const LOCK_STALE_MS = 30_000
/** Longer than the stale window, so a crashed owner's lock is always reclaimed and a live one still refuses at the end. */
export const LOCK_WAIT_MS = 35_000
/** How often the refused attempt is repeated; the lock is cheap to test and the boot is already waiting. */
export const LOCK_STEP_MS = 250

/** A synchronous pause: the lock is taken in a constructor, which cannot await. */
const rest = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** A refused lock means "held", not "broken": only holding it outlasts a wait, so a permission error must not be retried. */
const held = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false
  const { code, message } = error as { code?: string; message?: string }
  return code === 'ELOCKED' || (message ?? '').includes('already being held')
}

/** The pid file sits beside the lock directory rather than inside the state directory, where a database lives. */
const ownerPath = (stateDir: string): string => `${stateDir}.owner.json`

/** The owner's pid, when the file names one this module wrote. */
const ownerPid = (stateDir: string): number | undefined => {
  try {
    const { pid } = JSON.parse(readFileSync(ownerPath(stateDir), 'utf8')) as { pid?: unknown }
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : undefined
  } catch {
    return undefined
  }
}

/** Whether a process with this pid still runs: a killed one is gone, and waiting is then the only way in. */
const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export interface StateLockOptions {
  /** Called when the lock is compromised after it was taken, since a lock that was taken can also be lost. */
  onCompromised: (error: Error) => void
  /** Told how long the start has waited, so the log names a crashed instance rather than a bare refusal. */
  onWait?: (waitedMs: number) => void
  /** Replaced in a test, so the case does not spend the real window. */
  pause?: (ms: number) => void
  now?: () => number
}

/**
 * Takes the state-directory lock, waiting out a lock a killed instance left behind.
 * Returns the release to call on stop. A refusal whose owner still runs is thrown at once: waiting cannot outlast it.
 */
export function lockStateDir(stateDir: string, options: StateLockOptions): () => void {
  const now = options.now ?? Date.now
  const pause = options.pause ?? rest
  const deadline = now() + LOCK_WAIT_MS
  let waited = 0
  for (;;) {
    try {
      const release = lockSync(stateDir, { stale: LOCK_STALE_MS, onCompromised: options.onCompromised })
      try {
        writeFileSync(ownerPath(stateDir), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      } catch {
        // The pid file only makes a refusal fast; a lock without one is still correct, just slower to give up.
      }
      return () => {
        try {
          rmSync(ownerPath(stateDir), { force: true })
        } catch {
          // A pid file that cannot be removed names a pid that is about to stop running anyway.
        }
        release()
      }
    } catch (error) {
      if (!held(error)) throw error
      const owner = ownerPid(stateDir)
      // The killed instance whose lock goes stale is exactly the owner whose pid is gone; a live one keeps its lock.
      if (owner !== undefined && running(owner)) throw error
      if (now() >= deadline) throw error
      pause(LOCK_STEP_MS)
      waited += LOCK_STEP_MS
      options.onWait?.(waited)
    }
  }
}
