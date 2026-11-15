/**
 * Approval requests for the commands the gate never simply refuses: a force push or a repository delete may be what the
 * ticket is for, so the person who asked gets an interactive card with 批准/拒绝, and the worker's retry runs only while an
 * approval for that ticket and rule is live. An approval nobody answers expires after ten minutes; the worker then has to
 * ask again, which keeps a forgotten card from becoming standing permission.
 *
 * The card callback arrives through `lark-cli event consume card.action.trigger`, whose payload carries the button's
 * `action_value` (the approval id and the answer) and the `token` that updates the card in place.
 */
/** How long a card waits for an answer, and how long a granted approval stays usable, both ten minutes. */
export const APPROVAL_TIMEOUT_MS = 10 * 60_000

/** How long a person's refusal stands: the worker is told no rather than asking the same question again. */
export const APPROVAL_REFUSAL_MS = 10 * 60_000

/** How close to its deadline a question has to be before the thread hears about it, so the card does not lapse unseen. */
export const APPROVAL_REMIND_MS = 3 * 60_000

/** A rule a person may approve instead of the gate refusing it outright. */
export const APPROVABLE_RULES: readonly string[] = ['force_push', 'repo_delete']

/** Where a person answered: in the web panel, or on the card in Feishu. */
export type ApprovalVia = 'panel' | 'card'

/** One question put to a person, and its answer. */
/** What a person has answered so far: open questions and the outcomes of the closed ones. */
export interface ApprovalTally {
  readonly waiting: number
  readonly approved: number
  readonly rejected: number
  readonly expired: number
  readonly used: number
}

export interface ApprovalRequest {
  /** Stable id, carried in the card's button values. */
  readonly id: string
  readonly ticketId: string
  /** The shell rule that raised the question, such as `force_push`. */
  readonly rule: string
  /** The command line the worker tried, truncated for the card and the log. */
  readonly command: string
  /** The Feishu chat the card goes to; empty when the ticket has no reply target, where the request is logged only. */
  readonly chatId: string
  readonly askedAt: string
  /** After this instant a pending request is refused; a granted approval also stops working here. */
  readonly expiresAt: string
  state: 'pending' | 'approved' | 'rejected' | 'expired' | 'used'
  decidedAt?: string
  /** Who answered, as the callback reported them, such as an `ou_` id, or `panel` when no person is named. */
  decidedBy?: string
  /** Where the answer came from, so the record says which door a person walked through. */
  decidedVia?: ApprovalVia
  /** The card's message id, so its answer can update that same card. */
  messageId?: string
}

/** One question as the caller describes it. */
export interface ApprovalAsk {
  readonly ticketId: string
  readonly rule: string
  readonly command: string
  readonly chatId: string
}

/** The persistence the approvals need, which the orchestrator store provides. */
export interface ApprovalStore {
  get: (id: string) => ApprovalRequest | undefined
  save: (request: ApprovalRequest) => void
  list: () => ApprovalRequest[]
}

/** A long, stable id: the ticket, the rule, and the minute the request was made. */
function approvalId(ask: ApprovalAsk, at: Date): string {
  const stamp = at.toISOString().slice(0, 16)
  return `approval:${ask.ticketId}:${ask.rule}:${stamp}`
}

/**
 * The questions a ticket's irreversible commands wait on.
 */
export class Approvals {
  constructor(private readonly store: ApprovalStore, private readonly clock: () => Date = () => new Date()) {}

  /**
   * Records a question for a person, or returns the one already waiting for the same ticket and rule. A new question
   * carries its deadline, so a card nobody answers stops granting anything when it passes.
   */
  ask(ask: ApprovalAsk, at: Date = this.clock()): ApprovalRequest {
    const waiting = this.store.list().find(request => request.ticketId === ask.ticketId && request.rule === ask.rule && request.state === 'pending' && this.live(request, at))
    if (waiting !== undefined) return waiting
    const request: ApprovalRequest = {
      id: approvalId(ask, at),
      ticketId: ask.ticketId,
      rule: ask.rule,
      command: ask.command.slice(0, 500),
      chatId: ask.chatId,
      askedAt: at.toISOString(),
      expiresAt: new Date(at.getTime() + APPROVAL_TIMEOUT_MS).toISOString(),
      state: 'pending',
    }
    this.store.save(request)
    return request
  }

  /**
   * Records a person's answer to a pending question. An answer after the deadline changes nothing but the record: the
   * request becomes `expired`, which the worker reads as a refusal.
   */
  decide(id: string, answer: 'approve' | 'reject', by: string, via: ApprovalVia, at: Date = this.clock()): ApprovalRequest | undefined {
    const request = this.store.get(id)
    if (request === undefined || request.state !== 'pending') return undefined
    if (!this.live(request, at)) {
      request.state = 'expired'
      request.decidedAt = at.toISOString()
      request.decidedBy = by
      request.decidedVia = via
      this.store.save(request)
      return request
    }
    request.state = answer === 'approve' ? 'approved' : 'rejected'
    request.decidedAt = at.toISOString()
    request.decidedBy = by
    request.decidedVia = via
    this.store.save(request)
    return request
  }

  /**
   * Takes a live approval for the ticket and rule, so the command it names runs once. Returns the request used, or
   * `undefined` when no approval is waiting: the caller then asks again.
   */
  allow(ticketId: string, rule: string, at: Date = this.clock()): ApprovalRequest | undefined {
    const request = this.store.list().find(entry => entry.ticketId === ticketId && entry.rule === rule && entry.state === 'approved' && this.live(entry, at))
    if (request === undefined) return undefined
    request.state = 'used'
    this.store.save(request)
    return request
  }

  /** Pending questions, oldest first. */
  waiting(at: Date = this.clock()): ApprovalRequest[] {
    return this.store.list().filter(request => request.state === 'pending' && this.live(request, at))
  }

  /** Every question this installation asked, newest first, so the panel shows the ones still open above the rest. */
  list(): ApprovalRequest[] {
    return [...this.store.list()].sort((left, right) => right.askedAt.localeCompare(left.askedAt))
  }

  /**
   * The refusal still in force for this ticket and rule, so a worker told no stops asking instead of drawing a new card
   * on every attempt. A person may change their mind once the refusal lapses.
   */
  refused(ticketId: string, rule: string, at: Date = this.clock()): ApprovalRequest | undefined {
    return this.list().find(request => request.ticketId === ticketId && request.rule === rule && request.state === 'rejected'
      && at.getTime() - Date.parse(request.decidedAt ?? request.askedAt) < APPROVAL_REFUSAL_MS)
  }

  /**
   * Pending questions close to their deadline, oldest first, so the thread can warn about each of them once instead of
   * letting a card lapse while nobody looked at it.
   */
  expiring(at: Date = this.clock()): ApprovalRequest[] {
    return this.waiting(at).filter(request => Date.parse(request.expiresAt) - at.getTime() <= APPROVAL_REMIND_MS)
  }

  /**
   * Counts by outcome, so the panel can say how many questions a person answered and how, not only how many stay open.
   * A question that lapsed without an answer counts as expired, exactly as `advance` records it.
   */
  tally(at: Date = this.clock()): ApprovalTally {
    const list = this.store.list()
    return {
      waiting: list.filter(request => request.state === 'pending' && this.live(request, at)).length,
      approved: list.filter(request => request.state === 'approved').length,
      rejected: list.filter(request => request.state === 'rejected').length,
      expired: list.filter(request => request.state === 'expired').length,
      used: list.filter(request => request.state === 'used').length,
    }
  }

  /** What the health entry reports: how many questions still wait on a person, and how long the oldest has waited. */
  summary(at: Date = this.clock()): { waiting: number; oldestMinutes: number } {
    const waiting = this.waiting(at)
    const oldest = waiting[0]
    return {
      waiting: waiting.length,
      oldestMinutes: oldest === undefined ? 0 : Math.max(0, Math.round((at.getTime() - Date.parse(oldest.askedAt)) / 60_000)),
    }
  }

  /** Retires the questions nobody answered, and reports how many stopped granting anything. */
  advance(at: Date = this.clock()): number {
    let expired = 0
    for (const request of this.store.list()) {
      if ((request.state === 'pending' || request.state === 'approved') && !this.live(request, at)) {
        request.state = 'expired'
        this.store.save(request)
        expired++
      }
    }
    return expired
  }

  private live(request: ApprovalRequest, at: Date): boolean {
    return at.getTime() < Date.parse(request.expiresAt)
  }
}

/** The button an answer came from, as the card callback reports it. */
export interface ApprovalAnswer {
  readonly approval: string
  readonly answer: 'approve' | 'reject'
}

/**
 * The approval answer a card callback carries, or `undefined` for a card this plugin did not send: `action_value` is the
 * JSON string the button was built with, and its `approval` names the request.
 * @param payload - one parsed `card.action.trigger` event.
 */
export function approvalAnswer(payload: unknown): ApprovalAnswer | undefined {
  const value = (payload as { action_value?: unknown } | undefined)?.action_value
  if (typeof value !== 'string') return undefined
  let parsed: unknown
  try { parsed = JSON.parse(value) } catch { return undefined }
  const approval = (parsed as { approval?: unknown }).approval
  const answer = (parsed as { answer?: unknown }).answer
  if (typeof approval !== 'string' || approval === '') return undefined
  if (answer !== 'approve' && answer !== 'reject') return undefined
  return { approval, answer }
}

/**
 * The interactive card that asks a person to allow one irreversible command. The button values carry the approval id and
 * the answer, which is what the callback reads back; the deadline is in the card so nobody has to guess how long it lasts.
 * @param request - the question being asked.
 */
export function approvalCard(request: ApprovalRequest): string {
  const deadline = request.expiresAt.slice(11, 16)
  const card = {
    config: { wide_screen_mode: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '批准一次不可逆操作？' } },
    elements: [
      { tag: 'div', text: { tag: 'lark_md', content: `规则：\`${request.rule}\`\n工单：\`${request.ticketId}\`\n\n\`\`\`\n${request.command}\n\`\`\`` } },
      { tag: 'action', actions: [
        { tag: 'button', text: { tag: 'plain_text', content: '批准' }, type: 'primary', value: { approval: request.id, answer: 'approve' } },
        { tag: 'button', text: { tag: 'plain_text', content: '拒绝' }, type: 'danger', value: { approval: request.id, answer: 'reject' } },
      ] },
      { tag: 'note', elements: [{ tag: 'plain_text', content: `不处理则在 ${deadline} UTC 自动放弃；批准只对这一次命令生效。` }] },
    ],
  }
  return JSON.stringify(card)
}
