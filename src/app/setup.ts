/** Probes repository and account CLIs, configures the worker execution environment and command shims, and tracks setup readiness. */
import type { Context } from '@deepseek-ai/cordis'
import { UserError } from '../core/index.ts'
import { SETUP_FIELDS, resolveDeployment, resolveFeishuBot, workerProbe, type Deployment, type Machine } from '../deployment.ts'
import { agentVariables, applyEnvironment, verifyEnvironment, withoutDirectory, workerBin, writeEnvironment } from '../infra/environment.ts'
import type { Settings, SettingsBlock } from '../policy.ts'
import { SetupError, type SetupCode, type SetupProblem } from '../setup.ts'

export interface SetupHost {
  readonly context: Context
  readonly machine: Machine
  readonly lifetime: AbortSignal
  restart(): void
}

/** Setup problems a passing network condition causes: another attempt may succeed where the operator cannot act. */
const PASSING: ReadonlySet<SetupCode> = new Set<SetupCode>(['agentCliSignedOut'])
/** What a lost connection looks like in a CLI's own output, as opposed to the refusal the operator must act on. */
const NETWORK = /dial tcp|connectex|i\/o timeout|TLS handshake timeout|no such host|connection reset|connection refused|broken pipe|unexpected EOF|http2: client connection lost/i
/**
 * Whether a passing network may be the cause. A sign-out is retried because the probe cannot tell a real one from a lost
 * connection; every other problem is judged by what the CLI printed, so a refusal like a missing permission is not.
 */
export function passingSetup(error: SetupError): boolean {
  return PASSING.has(error.code) || NETWORK.test(error.values.output ?? '')
}
/** Waits before each retry of a passing setup problem; a sign-out that does not pass still stops after the last wait. */
const DEFAULT_RETRY_MS: readonly number[] = [2_000, 8_000]
/** Retry waits for setup, read from `DSH_SUPERAGENT_SETUP_RETRY_MS` (comma separated) so a test need not wait ten seconds. */
export function setupRetryMs(raw: string | undefined = process.env.DSH_SUPERAGENT_SETUP_RETRY_MS): readonly number[] {
  if (raw === undefined || raw.trim() === '') return DEFAULT_RETRY_MS
  return raw.split(',').map(part => Number.parseInt(part.trim(), 10)).filter(ms => Number.isFinite(ms) && ms >= 0)
}
/** A setup problem a passing network keeps causing is re-run on this wait, so an outage that outlasts the retries heals itself. */
const DEFAULT_REARM_MS = 300_000
/** Rearm wait, read from `DSH_SUPERAGENT_SETUP_REARM_MS`; `0` turns the rearm off. */
export function setupRearmMs(raw: string | undefined = process.env.DSH_SUPERAGENT_SETUP_REARM_MS): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_REARM_MS
  const ms = Number.parseInt(raw.trim(), 10)
  return Number.isFinite(ms) && ms >= 0 ? ms : DEFAULT_REARM_MS
}
const setupFields = (settings: Settings) =>
  JSON.stringify(Object.entries(SETUP_FIELDS).map(([id, keys]) => keys.map(key => settings.sources[id]?.config[key] ?? '')))
export const setupChanged = (before: Settings, after: Settings): boolean => setupFields(before) !== setupFields(after)

/**
 * Resolves the target repository, GitHub account, and optional Feishu bot by probing CLIs, then writes and applies the isolated git and shim environment used by worker processes.
 * `Runtime` runs it at startup to gate orchestration readiness, while `Settings` uses it to validate account changes, update blocked command shims, and schedule restarts.
 */
export class Setup {
  private resolved?: Deployment
  problem?: SetupProblem
  feishuProblem?: SetupProblem
  /** PATH with the worker shim directory removed so the host's own CLI calls invoke the real binaries. */
  private readonly path: string
  /** Environment variables pointing agent subprocesses at the isolated git config and command shims. */
  private readonly variables: Record<string, string | undefined>
  private restoreEnvironment?: () => void
  /** Waits before each retry of a passing setup problem, read once so a restart reads the current setting. */
  private readonly retry: readonly number[] = setupRetryMs()
  /** How long a setup problem a passing network keeps causing waits before the runtime runs setup again, read once. */
  private readonly rearmMs: number = setupRearmMs()
  /** Set while a rearm is scheduled, so retries that fail in a row do not stack timers. */
  private rearmed = false
  /** When the scheduled rearm fires, so the panel can tell a self-healing wait from a runtime that died on setup. */
  private rearmAt?: number
  constructor(private readonly host: SetupHost) {
    this.path = withoutDirectory(process.env.PATH ?? '', workerBin(host.machine.stateDir))
    this.variables = agentVariables(host.machine.stateDir)
  }
  /** Host command environment with agent git variables applied and the worker shim directory excluded from PATH. */
  get commandEnvironment(): Record<string, string | undefined> { return { ...this.variables, PATH: this.path } }
  get deployment(): Deployment {
    if (!this.resolved) throw new Error(`dsh-superagent is waiting for setup: ${this.problem?.detail ?? 'setup has not run'}`)
    return this.resolved
  }
  configured(): boolean { return this.resolved !== undefined }
  /** Resolve deployment accounts and apply the worker environment, recording `SetupError` failures in `problem`/`feishuProblem` and rethrowing unexpected errors. */
  async run(settings: Settings): Promise<boolean> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        this.resolved = await this.resolve(settings)
        this.problem = undefined
        this.rearmAt = undefined
        return true
      } catch (error) {
        if (!(error instanceof SetupError)) throw error
        this.problem = error.problem
        const wait = this.retry[attempt]
        const passing = passingSetup(error)
        // Only a problem a passing network causes is worth waiting out; a CLI the operator must configure is not.
        if (wait === undefined || !passing) {
          // Retries are spent: schedule one more setup run so an outage longer than the retries still heals itself.
          if (passing) this.rearm()
          return false
        }
        this.host.context.logger.info('dsh-superagent: setup hit %s; trying again in %dms', error.code, wait)
        await this.hold(wait)
        if (this.host.lifetime.aborted) return false
      }
    }
  }
  /** Waits between setup attempts, ending as soon as the runtime stops. */
  private hold(ms: number): Promise<void> {
    const { lifetime } = this.host
    if (ms <= 0 || lifetime.aborted) return Promise.resolve()
    return new Promise<void>(resolve => {
      let timer: ReturnType<typeof setTimeout>
      const done = (): void => { clearTimeout(timer); lifetime.removeEventListener('abort', done); resolve() }
      timer = setTimeout(done, ms)
      lifetime.addEventListener('abort', done, { once: true })
    })
  }
  /** The rearm a failing setup scheduled, or undefined when setup is healthy or no rearm is pending. */
  get rearmDue(): { dueAt: string } | undefined {
    return this.rearmAt === undefined ? undefined : { dueAt: new Date(this.rearmAt).toISOString() }
  }

  /** Schedules one setup run after `rearmMs`, so a passing network that outlasts the retries needs no operator restart. */
  private rearm(): void {
    const wait = this.rearmMs
    if (this.rearmed || wait <= 0) return
    const { lifetime } = this.host
    if (lifetime.aborted) return
    this.rearmed = true
    this.rearmAt = Date.now() + wait
    this.host.context.logger.info('dsh-superagent: setup is still failing; running it again in %dms', wait)
    const fire = (): void => { this.rearmed = false; this.rearmAt = undefined; this.restart() }
    const timer = setTimeout(fire, wait)
    // A pending rearm must not keep the process alive on its own.
    ;(timer as { unref?: () => void }).unref?.()
    lifetime.addEventListener('abort', () => clearTimeout(timer), { once: true })
  }
  /** Trigger a restart to re-run setup, refusing if setup and Feishu are already healthy so running assignments are not interrupted. */
  check(): void {
    if (this.configured() && !this.feishuProblem) throw new UserError('setupComplete')
    this.restart()
  }
  /** Defer the restart to the next macrotask so the current HTTP or tool caller receives its response first. */
  restart(): void { setTimeout(this.host.restart, 0) }
  /** Verify account CLIs for a modified source block before saving, ignoring setup errors belonging to other blocks. */
  async checkAccounts(block: SettingsBlock, settings: Settings): Promise<void> {
    const { machine } = this.host
    const check = block === 'source:feishu' ? resolveFeishuBot(machine, settings.sources.feishu?.config, this.probe())
      : resolveDeployment(machine, settings.sources.github?.config, this.probe())
    await check.catch((error: unknown) => { if (!(error instanceof SetupError) || error.place === block.slice(7)) throw error })
  }
  async blockCommands(blocked: readonly string[]): Promise<void> {
    if (this.resolved) await writeEnvironment(this.resolved, blocked)
  }
  restore(): void { this.restoreEnvironment?.(); this.restoreEnvironment = undefined }
  /** Probes CLIs the way worker shells run them, using `stateDir` as `cwd` since it exists even before the repository clone is valid. */
  private probe() {
    const { context, machine, lifetime } = this.host
    return workerProbe(context.subprocess, machine.stateDir, machine.stateDir, lifetime)
  }
  private async resolve(settings: Settings): Promise<Deployment> {
    const { context, machine, lifetime } = this.host
    const probe = this.probe()
    const deployment = await resolveDeployment(machine, settings.sources.github?.config, probe)
    const feishu = await resolveFeishuBot(machine, settings.sources.feishu?.config, probe).catch((error: unknown) => {
      if (!(error instanceof SetupError)) throw error
      this.feishuProblem = error.problem
      context.logger.warn('dsh-superagent leaves Feishu out: %s', error.message)
      return undefined
    })
    const resolved = { ...deployment, ...(feishu ? { feishu } : {}) }
    const machineProblem = (error: unknown): never => {
      if (error instanceof SetupError) throw error
      throw new SetupError('environmentFailed', { output: error instanceof Error ? error.message : String(error) })
    }
    await writeEnvironment(resolved, settings.executor.blockedCommands).catch(machineProblem)
    this.restoreEnvironment = applyEnvironment(this.variables, machine.stateDir, this.path)
    await verifyEnvironment(resolved, context.subprocess, lifetime).catch((error: unknown) => {
      this.restore()
      machineProblem(error)
    })
    return resolved
  }
}
