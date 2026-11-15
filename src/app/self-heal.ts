/** Repairs a main Session that DSH's archive gate refuses to wake before any model request. */
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** The slice of DSH's workspace registry that repairs an archived Session. */
export interface ArchiveRegistry {
  /** Session ids hidden from every grouping surface by DSH's archive set. */
  readonly archivedSessionIds: readonly string[]
  /** Drops one id from the durable archive set, without restarting the host. */
  unarchiveSession(sessionId: string): Promise<void>
}

export interface SelfHealHost {
  readonly masterId: string
  readonly stateDir: string
  readonly workspace: ArchiveRegistry
  /** Whether an operator allows automatic repair; `DSH_SUPERAGENT_AUTO_HEAL=0` turns it off. */
  readonly enabled: boolean
  readonly now: () => Date
  /** Minimum delay between two repairs of the same Session; defaults to five minutes. */
  readonly intervalMs?: number
  /** The registry file DSH persists the archive set to; copied aside before a repair, when known. */
  readonly registryPath?: string
}

/** What one repair attempt did. */
export type HealOutcome = 'unarchived' | 'not-archived' | 'throttled' | 'disabled'

/** The audit line one repair attempt appends to `self-heal.jsonl`. */
interface HealAudit {
  readonly at: string
  readonly masterId: string
  readonly reason: string
  readonly action: 'unarchive' | 'unarchive-failed'
  readonly outcomes?: HealOutcome
  /** The copy of the registry file taken before the repair, when a backup was written. */
  readonly backup?: string
}

/**
 * Repairs the software failure DSH's archive gate causes: a main Session listed in the workspace registry's archive set
 * rejects every wake at `agent/pre-step`, so no model request runs and the Session silently accepts no work. The gate
 * reads the registry's live set, so dropping the id through `unarchiveSession` repairs every later wake with no restart
 * and no hand-edited file. A repair is throttled per Session, so a failing host cannot loop, and every attempt is
 * appended to the state directory's audit log for later review.
 */
export class SelfHeal {
  private lastAt = 0

  constructor(private readonly host: SelfHealHost) {}

  /** The Session this healer repairs. */
  get masterId(): string {
    return this.host.masterId
  }

  /** Repairs the main Session when DSH archived it, and reports why it did or did not. */
  async heal(reason: string): Promise<HealOutcome> {
    if (!this.host.enabled) return 'disabled'
    const masterId = this.host.masterId
    if (!this.host.workspace.archivedSessionIds.includes(masterId)) return 'not-archived'
    const now = this.host.now()
    const interval = this.host.intervalMs ?? 5 * 60_000
    if (this.lastAt !== 0 && now.getTime() - this.lastAt < interval) return 'throttled'
    this.lastAt = now.getTime()
    const backup = this.backup(now)
    this.record({ at: now.toISOString(), masterId, reason, action: 'unarchive', ...(backup === undefined ? {} : { backup }) })
    try {
      await this.host.workspace.unarchiveSession(masterId)
    } catch (error) {
      this.record({ at: now.toISOString(), masterId, reason, action: 'unarchive-failed' })
      throw error
    }
    this.record({ at: now.toISOString(), masterId, reason, action: 'unarchive', outcomes: 'unarchived', ...(backup === undefined ? {} : { backup }) })
    return 'unarchived'
  }

  /** Copies the registry file aside so a bad repair can be compared against the file DSH had before it. */
  private backup(now: Date): string | undefined {
    const path = this.host.registryPath
    if (path === undefined || !existsSync(path)) return undefined
    const target = `${path}.bak-selfheal-${now.toISOString().replace(/[:.]/g, '-')}`
    try {
      copyFileSync(path, target)
      return target
    } catch {
      return undefined
    }
  }

  /** Appends one audit line; a failed audit never undoes a repair. */
  private record(entry: HealAudit): void {
    try {
      mkdirSync(this.host.stateDir, { recursive: true, mode: 0o700 })
      appendFileSync(join(this.host.stateDir, 'self-heal.jsonl'), `${JSON.stringify(entry)}\n`, { mode: 0o600 })
    } catch { /* The repair already happened; the audit is best effort. */ }
  }
}
