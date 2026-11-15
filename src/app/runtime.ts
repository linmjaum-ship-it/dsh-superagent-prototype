/** Application composition root and lifecycle manager for dsh-superagent. */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-subprocess'
import { existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { lockStateDir } from './state-lock.ts'
import { Engine, key, reasonText, type EngineForSettings, type ReceiveResult, type Ticket, type Trigger } from '../core/index.ts'
import { allowedSender, settingsPolicy } from '../policy.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Commands } from '../infra/commands.ts'
import type { Deployment, Machine } from '../deployment.ts'
import { environmentOf, ticketEnvironment, type Variable } from './execution-environment.ts'
import type { SetupProblem } from '../setup.ts'
import { DshExecutor, sourceTrigger, triggerMessage, workerSessionId } from '../executor/dsh.ts'
import { BrowserSessions } from './browser-sessions.ts'
import { ticketCard } from './cards.ts'
import { MasterAssessor } from './assessment.ts'
import { KV } from '../kv.ts'
import { Store } from './store.ts'
import { evalsHealth } from './views/overview.ts'
import { TextCache } from './cache.ts'
import { Effects } from './effects.ts'
import { Prompts } from './prompts.ts'
import { registerHttp, type HttpHost } from './http.ts'
import type { LinkTarget } from './views/records.ts'
import { candidateCard, repliedTo, sourceLink, type LinkHost } from './links.ts'
import { eventNotice, followupNotice } from './notices.ts'
import { pullEndNotices } from '../sources/github-pull.ts'
import { HealthBoard } from '../infra/health.ts'
import { Outbox } from './outbox.ts'
import { Passes } from './passes.ts'
import { SelfHeal } from './self-heal.ts'
import { FactCards, factsOf } from './facts.ts'
import { ProcessGuard, guardFiles } from './guard.ts'
import { type ApprovalRequest, approvalCard, Approvals } from './approvals.ts'
import { watchCards } from './card-consume.ts'
import { Routines } from './routines.ts'
import { UsageLedger } from './usage.ts'
import { commandSeam, compactionSeam } from './compaction.ts'
import { Setup } from './setup.ts'
import { feishuSettings } from '../sources/feishu.ts'
import { health, type Health, type SourceContext, type SourceHost } from '../sources/host.ts'
import { Sessions } from './sessions.ts'
import { Settings } from './settings.ts'
import { sourceContextOf, type SourceContextDeps } from './source-context.ts'
import type { ResourceHost } from './resources.ts'
import { mainTools, type MainToolsHost } from './tools/main.ts'
import { executorTools, type ExecutorToolsHost } from './tools/executor.ts'

// Source plugins interact with dsh-superagent exclusively through the `SourceHost` service interface.
declare module '@deepseek-ai/cordis' { interface Context { orchestrator: SourceHost } }
const now = (): string => new Date().toISOString()

/**
 * The registry file DSH keeps its archive set in, when the host state lives under `DSH_HOME`. The self-healer copies it
 * aside before a repair, so an operator can compare the file the host had with the one a repair wrote.
 */
function registryFile(): string | undefined {
  const home = process.env.DSH_HOME
  if (home === undefined || home === '') return undefined
  const path = join(home, 'storages', 'workspace.json')
  return existsSync(path) ? path : undefined
}

/**
 * Composition root of dsh-superagent that connects `Store`, `Setup`, `Engine`, `SourceRegistry`, `Effects`, `Outbox`, `Passes`, `Sessions`, `Settings`, `Prompts`, `DshExecutor`, and `MasterAssessor`.
 * Exposes the `SourceHost` service on the Cordis context for source plugins and coordinates startup, setup checks, HTTP route registration, and graceful shutdown.
 * Locks the state directory before opening SQLite so concurrent processes cannot corrupt or double-migrate state.
 */
export class Runtime extends Service implements SourceHost {
  readonly store: Store
  readonly setup: Setup
  readonly prompts: Prompts
  readonly effects: Effects
  readonly sources: SourceRegistry
  readonly commands: Commands
  readonly sessions: Sessions
  readonly settings: Settings
  readonly executor: DshExecutor
  readonly assessor: MasterAssessor
  readonly outbox: Outbox
  readonly engine: Engine
  readonly passes: Passes
  /** Repairs a blocked main-Session wake by dropping DSH's archive mark; undefined until the constructor builds it. */
  private selfHeal?: SelfHeal
  /** The last model catalog this runtime read, with when it read it. */
  private catalog?: { at: number; value: Promise<ModelCatalog> }
  /** Totals what each model request in the managed Sessions cost, for the cost panel. */
  readonly usage: UsageLedger
  /** The fact cards tickets keep, so a compacted history reads its bounds again on the next request. */
  readonly facts: FactCards
  /** The schedules the agent runs on its own; each fire enters as an inferred candidate the accept mode decides. */
  readonly routines: Routines
  /** The questions an irreversible command waits on: a person answers on a card, and the retry runs once. */
  readonly approvals: Approvals
  readonly ready: Promise<void>
  private readonly board = new HealthBoard()
  private readonly runtimeHealth = this.board.claim('runtime', { state: 'starting', detail: '' })
  readonly masterId: string
  private readonly sourceLinks = new TextCache(200_000)
  private readonly stopped = new AbortController()
  private readonly disposers: (() => void)[] = []
  /** Refusals already announced in their thread, so a retrying worker does not repeat the same notice. */
  private readonly announced = new Set<string>()
  /** Questions the thread was already warned about, so one card that lapses draws one warning, not a stream. */
  private readonly nudged = new Set<string>()
  private releaseLock?: () => Promise<void>
  private closingFlag = false
  private stopping?: Promise<void>
  private readonly sourceDeps: SourceContextDeps
  /** Kills a blocked command line in the workers' process tree; present when DSH_SUPERAGENT_GUARD=1. */
  private readonly guard?: ProcessGuard
  private readonly toolHost: MainToolsHost & ExecutorToolsHost
  /** Non-zero while a main-Session tool is executing an Engine command, suppressing self-triggered domain event notices. */
  private quiet = 0
  constructor(ctx: Context, readonly machine: Machine, restart: () => void) {
    super(ctx, 'orchestrator')
    const runtime = this
    // Lock the state directory before opening the database so another process cannot migrate or write concurrently.
    mkdirSync(machine.stateDir, { recursive: true, mode: 0o700 })
    const compromised = (error: Error) => { this.runtimeHealth.set({ state: 'error', detail: error.message }); this.stopped.abort() }
    // A killed instance leaves this lock behind until its stale window passes, so the start waits it out instead of
    // failing to mount: a refused lock that never expires is the only case that still ends in the refusal.
    const release = lockStateDir(machine.stateDir, { onCompromised: compromised,
      onWait: waited => ctx.logger.warn('dsh-superagent: still waiting for the state directory lock (%s ms)', String(waited)) })
    this.releaseLock = async () => { release() }
    let opened: Store | undefined
    try {
      const report = (error: unknown) => { ctx.logger.warn('dsh-superagent: %s', String(error)) }
      const store = opened = this.store = new Store(join(machine.stateDir, 'orchestrator.sqlite'), report)
      const setup = this.setup = new Setup({ context: ctx, machine, lifetime: this.lifetime, restart })
      const deployed = () => setup.configured()
        ? environmentOf({ deployment: setup.deployment, sources: this.sources, settings: store.settings() }) : undefined
      const feishu = () => setup.configured() && !!setup.deployment.feishu
      const prompts = this.prompts = new Prompts(store, () => machine.promptMaxChars.get(), deployed, feishu)
      const masterId = this.masterId = store.get(KV.runtime.masterId) ?? `orchestrator-${key(machine.stateDir)}`
      store.set(KV.runtime.masterId, masterId)
      const commands = this.commands = new Commands(() => setup.deployment, setup.commandEnvironment, this.lifetime,
        () => this.store.settings().executor.blockedCommands)
      const board = this.board
      const effects = this.effects = new Effects(store, board)
      const sources = this.sources = new SourceRegistry(() => store.settings(), board, kind => {
        // Sync source member lists once startup completes when a source plugin loads dynamically.
        if (kind.policy?.sync) void this.ready?.then(() => this.settings.syncable().includes(kind.kind) ? this.settings.sync(kind.kind) : undefined)
          .catch(() => { /* sync() records its failure in health. */ })
        return () => {}
      })
      const links: LinkHost = { store, links: this.sourceLinks, commands, sources, lifetime: this.lifetime }
      const link = (trigger: Trigger, signal?: AbortSignal) => sourceLink(links, trigger, signal)
      const environment = (ticket: Ticket) => this.ticketEnvironment(ticket)
      const resources: ResourceHost = { store, pages: new TextCache(4_000_000), prompts, commands, masterId, context: ctx,
        promptVersion: id => this.sessions.promptVersion(id), mayRead: (id, revision) => this.sessions.mayRead(id, revision),
        feishuPageSize: () => feishuSettings(sources).readPageSize, sourceLink: link }
      this.selfHeal = new SelfHeal({ masterId, stateDir: machine.stateDir, workspace: ctx.workspaceRegistry, registryPath: registryFile(),
        enabled: process.env.DSH_SUPERAGENT_AUTO_HEAL !== '0', now: () => new Date() })
      this.usage = new UsageLedger({ stateDir: machine.stateDir, now: () => new Date() })
      const facts = this.facts = new FactCards(join(machine.stateDir, 'tickets'))
      const approvals = this.approvals = new Approvals(store.approvals)
      // Questions a person has to answer: an idle-looking machine still has work stuck behind a card.
      const approvalsHealth = board.claim('approvals', { state: 'ready', detail: 'Nothing waiting on a person' })
      // A Session's shell is not the tool this package gates: the guard watches that shell's process tree instead.
      this.guard = process.platform === 'win32' && process.env.DSH_SUPERAGENT_GUARD === '1'
        ? new ProcessGuard(() => guardFiles(machine), () => store.settings().executor.blockedCommands, report)
        : undefined
      const sessions = this.sessions = new Sessions({ context: ctx, store, prompts, effects, health: board.claim('models'), masterId,
        onBlockedWake: detail => { void this.healWake(detail) },
        onUsage: (sessionId, role, event) => { this.usage.observe(sessionId, role, event) },
        alert: detail => { void this.reportRefusal(detail) },
        approved: (ticketId, rule) => approvals.allow(ticketId, rule) !== undefined,
        refused: (ticketId, rule) => approvals.refused(ticketId, rule) !== undefined,
        facts,
        wake: board.claim('wake', { state: 'ready', detail: 'No wake has been refused' }),
        lifetime: this.lifetime,
        closing: () => this.closing(), environment,
        tools: (agent, ticket) => ticket ? executorTools(this.toolHost, ticket) : mainTools(this.toolHost, agent) })
      const policyChanged: EngineForSettings['policyChanged'] = (from, to, effects) => { this.engine.policyChanged(from, to, effects) }
      this.settings = new Settings({ store, sources, engine: { policyChanged }, health: board, context: ctx, lifetime: this.lifetime, sessions,
        sourceHost: this, setup, requestPass: () => { this.passes.request() } })
      this.executor = new DshExecutor({ context: ctx, get engine() { return runtime.engine }, store, effects, health: board.claim('worker'), machine,
        lifetime: this.lifetime, sessions, closing: () => this.closing(), paused: () => this.paused(), environment, sourceLink: link,
        repliedTo: trigger => repliedTo({ store, sources }, trigger) })
      this.assessor = new MasterAssessor({ get engine() { return runtime.engine }, commands, get deployment() { return setup.deployment }, effects,
        settings: () => store.settings(), paused: () => this.paused(), threadContext: trigger => sources.threadContext(trigger),
        // External text is data: a flagged thread still reaches the main Session, but never silently.
        log: line => { ctx.logger.warn('dsh-superagent: %s', line) },
        // A candidate arrives when the main Session is usually idle: queue it so it opens a turn instead of steering a turn
        // that does not exist. This carries the 2026-11-14 diagnostic patch on the built bundle back into the source.
        deliver: (id, text) => sessions.prompt(masterId, id, text, 'queue'), candidateCard: candidate => candidateCard(links, candidate) })
      const outbox = this.outbox = new Outbox({ store, effects, sources, commands, paused: () => this.paused() })
      this.guard?.start(process.pid)
      const { assessor, executor } = this
      const policy = () => settingsPolicy(store.settings(), sources)
      const engine = this.engine = new Engine({ repo: store, scope: sources, policy, assessor, executor,
        outbox, prepareTicket: (ticket, outcome) => {
          const prepared = executor.prepare(ticket, outcome)
          // The card is the ticket's durable half: a compressed history must still know what bounded the work.
          // Remember it before the write, because the worker's first request is built in this same tick.
          const card = factsOf(prepared, setup.deployment.repository, new Date().toISOString())
          facts.remember(card)
          void facts.write(card).catch(report)
          return prepared
        }, emit: event => {
          // Notify the main Session only about domain events it did not initiate itself.
          const notice = this.quiet ? undefined : eventNotice(event, id => store.tickets.get(id))
          if (notice) sessions.notify(...notice)
          // A person's message that reached an open ticket is the ticket's; the main Session hears of it in the same transaction,
          // and of one for an ended ticket once it resumes, unless it routed the message there itself.
          const followed = !this.quiet && (event.type === 'trigger.received' || event.type === 'ticket.resumed' || event.type === 'trigger.followup')
          const followup = followed ? followupNotice(store, sources, event.data.triggerId) : undefined
          if (followup) sessions.relay(followup.id, followup.text)
          // Notify the ticket's conversations whenever it ends via a pull request.
          const ended = event.type === 'ticket.ended' ? store.tickets.get(event.data.ticketId) : undefined
          if (ended && setup.configured()) {
            const request = store.triggers.get(ended.origin.triggerId)?.text ?? ''
            for (const message of pullEndNotices(ended, request, setup.deployment.repository)) outbox.send(message)
          }
        } })
      // Update the `evals` health entry on every pass if an evaluation failed as unavailable within the last hour.
      const evals = board.claim('evals', { state: 'ready', detail: 'No unavailable Eval in the last hour' })
      const evaluateDue = () => { engine.evaluateDue(); evals.set(evalsHealth(store)) }
      const routines = this.routines = new Routines(store, { receive: trigger => passes.receive(trigger),
        log: line => { this.ctx.logger.info('dsh-superagent: %s', line) } })
      const passes = this.passes = new Passes({ engine: { receive: trigger => engine.receive(trigger), evaluateDue }, effects,
        advance: () => {
          routines.advance()
          approvals.advance()
          const { waiting, oldestMinutes } = approvals.summary()
          approvalsHealth.set(waiting === 0
            ? { state: 'ready', detail: 'Nothing waiting on a person', at: now() }
            : { state: 'ready', detail: `${waiting} question${waiting === 1 ? '' : 's'} waiting on a person; the oldest for ${oldestMinutes} minute${oldestMinutes === 1 ? '' : 's'}`, at: now() })
          this.nudgeApprovals()
        },
        health: this.runtimeHealth, lifetime: this.lifetime, configured: () => setup.configured(), closing: () => this.closing(),
        waiting: () => !!store.db.prepare('SELECT 1 FROM effect LIMIT 1').get(),
        log: line => { this.ctx.logger.info('dsh-superagent: %s', line) } })
      this.sourceDeps = { store, engine, outbox, commands, sources, get ready() { return runtime.ready },
        get deployment() { return setup.deployment }, configured: () => setup.configured(),
        get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem }, receive: trigger => passes.receive(trigger) }
      // A browser is off unless the profile asks for it: once open it can click anything a person could.
      const browsers = process.env.DSH_SUPERAGENT_BROWSER === '1' ? new BrowserSessions() : undefined
      if (browsers !== undefined) this.disposers.push(() => { void browsers.closeAll() })
      this.toolHost = { context: ctx, engine, store, prompts, sessions, settings: this.settings, assessor, resources,
        ...(browsers === undefined ? {} : { browser: browsers }),
        get github() { return runtime.context({ kind: 'github', health: ['github'] }) },
        requestPass: () => { passes.request() }, sendReplies: () => outbox.sent(),
        quietly: run => { this.quiet++; try { return run() } finally { this.quiet-- } } }
      this.ready = this.initialize()
    } catch (error) {
      // Release the database and state lock if initialization fails so an in-process restart can reacquire them.
      try { opened?.close() } finally { release() }
      throw error
    }
  }
  get health(): Readonly<Record<string, Health>> { return this.board.all }
  /** Aborted when dsh-superagent stops or loses its state directory lock, cancelling running reads and subprocesses. */
  get lifetime(): AbortSignal { return this.stopped.signal }
  context(kind: { kind: string; health: readonly string[] }): SourceContext { return sourceContextOf(this.sourceDeps, kind) }
  /** Resolved deployment; throws while waiting for setup (`!configured()`). */
  get deployment(): Deployment { return this.setup.deployment }
  configured(): boolean { return this.setup.configured() }
  get setupProblem(): SetupProblem | undefined { return this.setup.problem }
  /** The rearm a failing setup scheduled, which the state view reports so a wait is not mistaken for a dead runtime. */
  get rearm(): { dueAt: string } | undefined { return this.setup.rearmDue }
  /** Why the Feishu bot is unavailable even though the Feishu Source configures a CLI. */
  get feishuProblem(): SetupProblem | undefined { return this.setup.feishuProblem }
  links(): LinkTarget {
    const resolved = this.setup.configured() ? this.setup.deployment : undefined
    const links = resolved ? { repository: resolved.repository, ...(resolved.feishu ? { feishu: resolved.feishu } : {}) } : {}
    return channel => this.sources.link(channel, links)
  }
  ticketEnvironment(ticket: Ticket): Variable[] {
    const trigger = sourceTrigger(this, ticket)
    const { setup: { deployment }, sources } = this
    return ticketEnvironment({ deployment, sources, settings: this.store.settings(), ticket, ...trigger ? { trigger } : {} })
  }
  checkSetup(): void { this.setup.check() }
  receive(trigger: Trigger): ReceiveResult { return this.passes.receive(trigger) }
  idle(): Promise<void> { return this.passes.idle() }
  pump(): Promise<void> { return this.passes.pump() }
  sendReplies(): Promise<void> { return this.outbox.sent() }
  private closing(): boolean { return this.closingFlag }
  /**
   * Repairs a refused wake: when DSH archived the main Session, its archive gate rejects every wake before any model
   * request. Dropping the mark repairs later wakes, and a fresh turn lets the Session carry on. `DSH_SUPERAGENT_AUTO_HEAL=0`
   * leaves the repair to a person.
   */
  /**
   * Tells the person who asked, in the thread they asked in, that a worker's shell command was refused by the command
   * gate. A ticket from another source, or one with no reply target, is logged only: the refusal itself already happened.
   */
  private async reportRefusal({ ticketId, rule, command, approvable, refused = false }: { ticketId: string; rule: string; command: string; approvable: boolean; refused?: boolean }): Promise<void> {
    this.ctx.logger.warn('dsh-superagent: the command gate refused %s in ticket %s', rule, ticketId)
    // A refusal the person already gave needs no question; the thread hears once that the worker is blocked by it.
    if (refused) { await this.announceRefusal({ ticketId, rule, command }); return }
    const origin = this.store.tickets.get(ticketId)?.origin.triggerId
    const channel = origin === undefined ? undefined : this.store.triggers.get(origin)?.channel
    const messageId = channel?.source === 'feishu' ? channel.address.messageId : undefined
    const chatId = channel?.source === 'feishu' ? channel.address.chatId : undefined
    // An approvable rule is put to a person on a card; the other rules are refused, and the thread is told why.
    if (approvable && chatId !== undefined) { await this.askApproval({ ticketId, rule, command, chatId }); return }
    if (messageId === undefined) return
    const text = `**The command gate refused a command** (rule: \`${rule}\`)\n` + (command === '' ? '' : `\n\`\`\`\n${command}\n\`\`\`\n`) + '\nThe worker keeps its other tools; approve a different approach by replying here.'
    try {
      await this.commands.lark(['im', '+messages-reply', '--message-id', messageId, '--markdown', text, '--reply-in-thread', '--idempotency-key', key('gate', ticketId, rule, String(Date.now()))])
    } catch (error) { this.ctx.logger.warn('dsh-superagent: could not report a refused command: %s', String(error)) }
  }

  /**
   * Tells the thread, once per refusal, that the person's own answer is what stops the worker: without it a quiet worker
   * looks broken, and a retrying one would repeat the same line on every attempt.
   */
  /**
   * Warns the thread about every question close to lapsing, once per question: a card nobody opened should not expire unseen.
   * Called from the pass tick, so it costs nothing while nothing waits.
   */
  nudgeApprovals(at: Date = new Date()): void {
    for (const request of this.approvals.expiring(at)) {
      if (this.nudged.has(request.id)) continue
      this.nudged.add(request.id)
      void this.remindApproval(request, at)
    }
  }

  private async remindApproval(request: ApprovalRequest, at: Date): Promise<void> {
    const left = Math.max(1, Math.round((Date.parse(request.expiresAt) - at.getTime()) / 60_000))
    const text = `**An approval is about to lapse** (rule: \`${request.rule}\`)\n`
      + (request.command === '' ? '' : `\n\`\`\`\n${request.command}\n\`\`\`\n`)
      + `\nNobody answered in ${String(left)} minute${left === 1 ? '' : 's'}; the worker cannot run this command until someone does.`
    const args = request.messageId === undefined
      ? ['api', 'POST', '/open-apis/im/v1/messages', '--params', JSON.stringify({ receive_id_type: 'chat_id' }),
        '--data', JSON.stringify({ receive_id: request.chatId, msg_type: 'text', content: JSON.stringify({ text }) })]
      : ['im', '+messages-reply', '--message-id', request.messageId, '--markdown', text, '--reply-in-thread', '--idempotency-key', key('lapse', request.id)]
    try {
      await this.commands.lark(args)
    } catch (error) { this.ctx.logger.warn('dsh-superagent: could not warn about a lapsing approval: %s', String(error)) }
  }

  private async announceRefusal({ ticketId, rule, command }: { ticketId: string; rule: string; command: string }): Promise<void> {
    const refusal = this.approvals.refused(ticketId, rule)
    if (refusal === undefined || this.announced.has(refusal.id)) return
    this.announced.add(refusal.id)
    const origin = this.store.tickets.get(ticketId)?.origin.triggerId
    const channel = origin === undefined ? undefined : this.store.triggers.get(origin)?.channel
    const messageId = channel?.source === 'feishu' ? channel.address.messageId : undefined
    if (messageId === undefined) return
    const text = `**A command stays refused** (rule: \`${rule}\`)\n` + (command === '' ? '' : `\n\`\`\`\n${command}\n\`\`\`\n`)
      + '\nYou answered no, so this one stays refused for ten minutes. The worker will not ask again; it needs a different approach.'
    try {
      await this.commands.lark(['im', '+messages-reply', '--message-id', messageId, '--markdown', text, '--reply-in-thread', '--idempotency-key', key('refusal', refusal.id)])
    } catch (error) { this.ctx.logger.warn('dsh-superagent: could not report a refused approval: %s', String(error)) }
  }

  /**
   * Sends the card that asks a person to allow one irreversible command, and records the message so an answer can point
   * back at it. A failed send stays logged: without a card the approval never becomes live, so the worker keeps its refusal.
   */
  private async askApproval(ask: { ticketId: string; rule: string; command: string; chatId: string }): Promise<void> {
    const request = this.approvals.ask(ask)
    if (request.messageId !== undefined) return
    try {
      const sent = String(await this.commands.lark(['api', 'POST', '/open-apis/im/v1/messages', '--params', JSON.stringify({ receive_id_type: 'chat_id' }),
        '--data', JSON.stringify({ receive_id: ask.chatId, msg_type: 'interactive', content: approvalCard(request) })]))
      const messageId = /"message_id"\s*:\s*"([^"]+)"/.exec(sent)?.[1]
      if (messageId === undefined) { this.ctx.logger.warn('dsh-superagent: the approval card was sent without a message id'); return }
      request.messageId = messageId
      this.store.approvals.save(request)
    } catch (error) { this.ctx.logger.warn('dsh-superagent: could not send the approval card: %s', String(error)) }
  }

  private async healWake(detail: string): Promise<void> {
    if (this.closingFlag) return
    let outcome: string | undefined
    try {
      outcome = await this.selfHeal?.heal(detail)
    } catch (error) {
      this.ctx.logger.warn('dsh-superagent: self-heal failed: %s', String(error))
      return
    }
    if (outcome !== 'unarchived' || this.closingFlag) return
    await this.sessions.prompt(this.masterId, `self-heal:${Date.now()}`,
      'The host repaired a blocked wake: this Session had been archived, so every wake was refused. It is awake again; carry on with whatever is due.', 'queue')
  }
  /** Hold evaluation, dispatch, and outbound delivery while paused or awaiting setup; sources still record incoming triggers. */
  private paused(): boolean { return !this.setup.configured() || this.store.settings().paused }
  private async initialize(): Promise<void> {
    // Register management HTTP routes before setup completes so operators can fix setup problems in the UI.
    this.disposers.push(registerHttp(this.ctx, this.httpHost()))
    if (!await this.setup.run(this.store.settings())) {
      this.runtimeHealth.set({ ...health('paused', 'setupPending'), at: now() })
      return
    }
    this.sessions.install()
    this.executor.install()
    await this.sessions.ensure(this.masterId, this.machine.stateDir, 'dsh-superagent orchestrator', 'orchestrator')
    for (const id of this.settings.syncable()) await this.settings.sync(id).catch(() => { /* sync() records its failure in health. */ })
    // If stop() was called while awaiting setup, session creation, or policy sync, do not start background loops.
    if (this.closing()) return
    this.executor.resume()
    this.passes.start()
    // The card consumer shares the Feishu Source's bot connection; without a bot the cards are only logged.
    if (this.setup.deployment.feishu !== undefined) {
      const cli = this.setup.deployment.feishu.cli
      void watchCards({ approvals: this.approvals, cli, log: line => { this.ctx.logger.info('dsh-superagent: %s', line) } }, this.lifetime)
        .catch((error: unknown) => { this.ctx.logger.warn('dsh-superagent: the card consumer stopped for good: %s', String(error)) })
    }
    this.effects.start()
    this.runtimeHealth.set({ state: 'ready', detail: 'Orchestrator is ready', at: now() })
  }
  /** The model catalog, read at most once an hour: it changes when a provider is configured, not per panel refresh. */
  models(): Promise<ModelCatalog> {
    const now = Date.now()
    if (this.catalog === undefined || now - this.catalog.at > 3_600_000) this.catalog = { at: now, value: this.ctx.sessionController.modelCatalog() }
    return this.catalog.value
  }
  /**
   * Compact one Ticket's Session now. The host's automatic pass waits for a token threshold a worker rarely reaches inside
   * one Ticket, so an operator who wants the history small sooner asks here; the fact card is rebuilt on the next request.
   */
  async compactTicket(id: string): Promise<{ compacted: boolean }> {
    // A Ticket whose turn already ended has no live Agent, but its Session is on disk: resolve it so an operator can
    // still shrink the history a later turn would read.
    const resolved = await this.ctx.sessionController.resolveAgent(workerSessionId(id) as SessionId)
    if ('error' in resolved) throw new Error(`Ticket ${id} has no Session to compact`)
    // The compaction backend belongs to the Agent preset, which mounts it in that preset's own realm, so the service is
    // read from this Session's context rather than the host's: the host plane deliberately carries only the token meter.
    const seam = compactionSeam(resolved.agent.ctx) ?? compactionSeam(this.ctx)
    if (seam !== undefined) {
      const result = await seam.compactNow(resolved.agent, this.lifetime)
      return { compacted: result !== null && result !== undefined }
    }
    // A preset that isolates the backend leaves only its own `/compact` command holding it: run that command for this
    // Session, which is what a human would type, and let the command's own handler reach the service inside the realm.
    const commands = commandSeam(this.ctx)
    if (commands === undefined) throw new Error('This host mounts no command service, so a Session cannot be compacted on demand')
    const execution = await commands.execute(resolved.agent, '/compact', [], this.lifetime)
    if (execution === undefined) throw new Error(`Ticket ${id} runs a preset with no compact command, so its Session cannot be compacted on demand`)
    return { compacted: true }
  }
  /**
   * Selftest only: open one turn on a Ticket's Session the way a person's message does. A compacted Session is only
   * read again by a later request, so a diagnostic needs a way to ask for that request without a real chat message.
   */
  async promptTicket(id: string, text: string): Promise<{ prompted: true }> {
    await this.sessions.prompt(workerSessionId(id), key('selftest', id, String(Date.now())), text, 'queue')
    return { prompted: true }
  }
  private httpHost(): HttpHost {
    const runtime = this
    const { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, setup, passes, usage,
      routines, approvals } = this
    return { store, sources, prompts, sessions, settings, engine, executor, health, machine, masterId, ready, sourceLinks, usage, routines, approvals,
      get deployment() { return setup.deployment },
      get setupProblem() { return setup.problem }, get feishuProblem() { return setup.feishuProblem },
      get rearm() { return setup.rearmDue },
      configured: () => setup.configured(), links: () => runtime.links(), ticketEnvironment: ticket => runtime.ticketEnvironment(ticket),
      checkSetup: () => { setup.check() }, requestPass: () => { passes.request() }, models: () => runtime.models(), passes,
      compactTicket: id => runtime.compactTicket(id), promptTicket: (id, text) => runtime.promptTicket(id, text) }
  }
  /** Idempotent stop; concurrent or repeated calls share the same shutdown promise. */
  stop(): Promise<void> { return this.stopping ??= this.shutdown() }
  private async shutdown(): Promise<void> {
    this.closingFlag = true; const passes = this.passes.stop(); this.stopped.abort()
    try {
      this.assessor.stop()
      const ids = [this.masterId, ...this.store.tickets.list().map(ticket => workerSessionId(ticket.id))]
      const agents = ids.map(id => this.ctx.agents.get(id as SessionId)).filter((agent): agent is Agent => agent !== undefined)
      for (const agent of agents) agent.cancel({ kind: 'user' }, { keepInbox: true })
      await Promise.allSettled([passes, this.effects.drain(), ...agents.map(agent => agent.whenIdle())])
      await this.guard?.stop()
      // The workers' jobs and subagents stop too: their ends would start worker turns without the tool limits released below.
      await this.executor.shutdown()
      this.executor.dispose()
      this.sessions.dispose()
      for (const dispose of this.disposers.reverse()) dispose()
      await this.ctx.sessionPersistence.flush()
    } finally {
      // Close the database before releasing the directory lock so another process cannot open the database mid-write; a compromised lock may already be released.
      this.setup.restore()
      try { this.store.close() } finally {
        const unreleased = (error: unknown) => { this.ctx.logger.warn('dsh-superagent could not release its state directory lock: %s',
          String(error)) }
        await this.releaseLock?.().catch(unreleased)
      }
    }
  }
}
