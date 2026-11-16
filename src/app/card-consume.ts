/**
 * Watches the cards this plugin sends, so a person's click becomes an answer. The callback arrives on the same bot long
 * connection the Feishu Source uses, through `lark-cli event consume card.action.trigger`; the tool streams one JSON object
 * per line and prints its readiness on stderr, exactly as `im.message.receive_v1` does.
 *
 * The consumer reconnects with the Source's own backoff, because a dropped long connection would otherwise mean a card
 * whose buttons silently stop working.
 */
import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { approvalAnswer, type Approvals, type ApprovalRequest } from './approvals.ts'
import { launchCommand } from '../infra/launch.ts'

/** The event the cards answer on. */
export const CARD_EVENT = 'card.action.trigger'

/** One parsed callback, as the consumer reads it. */
export interface CardAction {
  readonly chatId: string
  readonly messageId: string
  readonly operator: string
  readonly payload: unknown
}

/** What the consumer needs from the plugin. */
export interface CardConsumerHost {
  readonly approvals: Approvals
  /** The bot `lark-cli` the deployment resolved, which the Feishu Source also uses. */
  readonly cli: string
  readonly log?: (line: string) => void
  /** Tells the chat which answer was recorded; failures are logged, never retried here. */
  readonly report?: (request: ApprovalRequest, answer: 'approve' | 'reject', action: CardAction) => Promise<void>
}

/** One line of the consumer's stderr said it was subscribed. */
const READY = /^\[event\] ready\b/

/** Backoff for a consumer that keeps dropping: one second, then doubling, capped at a minute. */
export const cardRetry = (previous: number | undefined, ranMs: number): number => previous === undefined || ranMs >= 60_000 ? 1_000 : Math.min(previous * 2, 60_000)

/**
 * The chat, card message, and person a callback names. A payload missing them is ignored: an answer with no approval to
 * match would only write a record nobody asked for.
 * @param payload - one parsed `card.action.trigger` event.
 */
export function cardAction(payload: unknown): CardAction | undefined {
  const event = payload as { chat_id?: unknown; message_id?: unknown; operator_id?: unknown; user_id?: unknown; token?: unknown } | undefined
  const chatId = typeof event?.chat_id === 'string' ? event.chat_id : ''
  if (chatId === '') return undefined
  const operator = typeof event?.operator_id === 'string' ? event.operator_id : typeof event?.user_id === 'string' ? event.user_id : ''
  return {
    chatId,
    messageId: typeof event?.message_id === 'string' ? event.message_id : '',
    operator,
    payload,
  }
}

/**
 * Reads one callback line and records the answer it carries, if any.
 * @param line - one NDJSON line from the consumer.
 * @param host - the approvals to answer and the log to write to.
 */
export async function handleCardLine(line: string, host: CardConsumerHost): Promise<ApprovalRequest | undefined> {
  let payload: unknown
  try { payload = JSON.parse(line) } catch { host.log?.(`card callback was not JSON: ${line.slice(0, 200)}`); return undefined }
  const answer = approvalAnswer(payload)
  const action = cardAction(payload)
  if (answer === undefined || action === undefined) return undefined
  const request = host.approvals.decide(answer.approval, answer.answer, action.operator, 'card')
  if (request === undefined) { host.log?.(`card ${action.messageId} answered ${answer.answer} for an approval that was not pending: ${answer.approval}`); return undefined }
  host.log?.(`approval ${request.id} ${request.state} by ${action.operator || 'unknown'}`)
  try { await host.report?.(request, answer.answer, action) } catch (error) { host.log?.(`could not confirm approval ${request.id}: ${String(error)}`) }
  return request
}

/**
 * Subscribes to the card callbacks until `signal` aborts, reconnecting when the child exits. Returns when the consumer is
 * stopped, or throws only when it cannot start at all.
 */
export async function watchCards(host: CardConsumerHost, signal: AbortSignal): Promise<void> {
  let retry: number | undefined
  while (!signal.aborted) {
    const began = Date.now()
    try { await consume(host, signal) } catch (error) {
      if (signal.aborted) return
      host.log?.(`card consumer stopped: ${String(error)}`)
    }
    if (signal.aborted) return
    retry = cardRetry(retry, Date.now() - began)
    await new Promise<void>(resolve => { const timer = setTimeout(resolve, retry); signal.addEventListener('abort', () => { clearTimeout(timer); resolve() }, { once: true }) })
  }
}

/** One subscription: spawn, wait for the ready line, and turn each event into an answer. */
function consume(host: CardConsumerHost, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const launched = launchCommand(host.cli, ['event', 'consume', CARD_EVENT, '--as', 'bot'])
    const child = spawn(launched.command, [...launched.args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1', LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1' },
    })
    let ready = false
    let gone = false
    let diagnostic = ''
    const timer = setTimeout(() => { if (!ready) diagnose('card consumer did not become ready within 45 seconds') }, 45_000)
    // A spawn that never started a process has no stdin to close and no child to signal; both calls stay best effort.
    const stop = (): void => {
      clearTimeout(timer)
      try { child.stdin?.end() } catch { /* the pipe is already gone */ }
      try { if (!gone && child.exitCode === null) child.kill('SIGTERM') } catch { /* the process is already gone */ }
    }
    signal.addEventListener('abort', stop, { once: true })
    const diagnose = (line: string): void => { diagnostic = line; host.log?.(line) }
    createInterface({ input: child.stderr }).on('line', line => {
      if (READY.test(line)) { ready = true; clearTimeout(timer); return }
      if (/WARN|drop|error/i.test(line)) diagnose(line)
    })
    let chain = Promise.resolve()
    createInterface({ input: child.stdout }).on('line', line => {
      if (line.length > 1_048_576 || line.trim() === '') return
      chain = chain.then(() => handleCardLine(line, host).then(() => undefined)).catch((error: unknown) => diagnose(`card callback failed: ${String(error)}`))
    })
    // A missing CLI is a stop, not a crash: the watcher logs it and retries with backoff, like a dropped connection.
    child.on('error', (error: unknown) => { gone = true; clearTimeout(timer); diagnose(`card consumer failed: ${String(error)}`); resolve() })
    child.on('close', (code: number | null) => {
      clearTimeout(timer)
      signal.removeEventListener('abort', stop)
      if (signal.aborted || gone) resolve()
      else reject(new Error(`card consumer exited (${String(code)}, ready=${String(ready)}): ${diagnostic}`))
    })
  })
}
