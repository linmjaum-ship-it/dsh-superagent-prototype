/** Fact cards: the durable facts a long ticket keeps once its Session's history is compressed. */
import { existsSync, readFileSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Ticket } from '../core/model.ts'

/** What a ticket must not forget: the parts of its Mandate a compressed history would otherwise drop. */
export interface TicketFacts {
  ticketId: string
  title: string
  repository: string
  strength: string
  scope: string
  acceptance: string[]
  constraints: string[]
  blockedPaths: string[]
  pullRequest?: number
  updatedAt: string
}

/** The line every injected card starts with, which tests and operators grep a Session's journal for. */
export const FACTS_MARKER = 'TICKET-FACTS'

/** Keep a card small: it is re-injected on every request, so a runaway list would cost more than the context it restores. */
const MAX_FACTS = 8
const MAX_CARD = 2_000

const MAX_ITEM = 200

const lines = (label: string, items: readonly string[]): string[] => items.length === 0
  ? [] : [`${label}:`, ...items.slice(0, MAX_FACTS).map(item => `- ${item.length <= MAX_ITEM ? item : `${item.slice(0, MAX_ITEM)}…`}`)]

/** Render one card: the block a Session reads after compaction, in the order a reader needs it. */
export function renderFacts(facts: TicketFacts): string {
  const block = [
    `${FACTS_MARKER} (durable; this block survives compaction)`,
    `ticket: ${facts.ticketId}`,
    `title: ${facts.title}`,
    `repository: ${facts.repository}`,
    `mandate: ${facts.strength}; scope: ${facts.scope}`,
    ...lines('acceptance', facts.acceptance),
    ...lines('constraints', facts.constraints),
    ...lines('do not change', facts.blockedPaths),
    ...(facts.pullRequest === undefined ? [] : [`pull request: #${facts.pullRequest}`]),
    `updated: ${facts.updatedAt}`,
  ].join('\n')
  return block.length <= MAX_CARD ? block : `${block.slice(0, MAX_CARD)}\n- (card truncated)`
}

/** Serialize a card as the small YAML-shaped file an operator can read and edit between Sessions. */
export function serializeFacts(facts: TicketFacts): string {
  const source = [
    `ticket: ${facts.ticketId}`,
    `title: ${facts.title}`,
    `repository: ${facts.repository}`,
    `strength: ${facts.strength}`,
    `scope: ${facts.scope}`,
    `updated: ${facts.updatedAt}`,
    ...lines('acceptance', facts.acceptance),
    ...lines('constraints', facts.constraints),
    ...lines('do_not_change', facts.blockedPaths),
    ...(facts.pullRequest === undefined ? [] : [`pull_request: ${facts.pullRequest}`]),
  ]
  return `${source.join('\n')}\n`
}

const scalar = (text: string | undefined): string | undefined => text === undefined ? undefined : text.trim()

/** Read back a card this module wrote, or `undefined` when the file is missing or unreadable as a card. */
export function parseFacts(text: string): TicketFacts | undefined {
  const single = new Map<string, string>()
  const lists = new Map<string, string[]>()
  let current: string | undefined
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd()
    if (line.length === 0) continue
    const bullet = /^\s*-\s+(.*)$/.exec(line)
    if (bullet && current !== undefined) { lists.set(current, [...lists.get(current) ?? [], bullet[1]!.trim()]); continue }
    const field = /^([a-z_]+):\s*(.*)$/.exec(line)
    if (!field) continue
    const value = field[2]!.trim()
    if (value.length === 0) { current = field[1]!; continue }
    current = undefined
    single.set(field[1]!, value)
  }
  const ticketId = scalar(single.get('ticket'))
  const repository = scalar(single.get('repository'))
  const updatedAt = scalar(single.get('updated'))
  if (!ticketId || !repository || !updatedAt) return undefined
  const pull = scalar(single.get('pull_request'))
  const pullRequest = pull === undefined ? undefined : Number.parseInt(pull, 10)
  return {
    ticketId,
    title: scalar(single.get('title')) ?? '',
    repository,
    strength: scalar(single.get('strength')) ?? '',
    scope: scalar(single.get('scope')) ?? '',
    acceptance: lists.get('acceptance') ?? [],
    constraints: lists.get('constraints') ?? [],
    blockedPaths: lists.get('do_not_change') ?? [],
    pullRequest: pullRequest === undefined || Number.isNaN(pullRequest) ? undefined : pullRequest,
    updatedAt,
  }
}

/** The pull request a ticket follows, read from the Threads it opened. */
export function pullRequestOf(ticket: Pick<Ticket, 'follows'>): number | undefined {
  for (const follow of ticket.follows ?? []) {
    const match = /^github:(\d+)$/.exec(follow.thread)
    if (match && follow.own) return Number.parseInt(match[1]!, 10)
  }
  return undefined
}

/** The card a freshly accepted ticket starts with: its Mandate's bounds, and no confirmed constraint yet. */
export function factsOf(ticket: Ticket, repository: string, at: string): TicketFacts {
  const rules = 'rules' in ticket.mandate.basis && Array.isArray(ticket.mandate.basis.rules) ? ticket.mandate.basis.rules : []
  const pullRequest = pullRequestOf(ticket)
  return {
    ticketId: ticket.id,
    title: ticket.title,
    repository,
    strength: ticket.mandate.strength,
    scope: ticket.mandate.scope,
    acceptance: [],
    constraints: rules,
    blockedPaths: [],
    ...(pullRequest === undefined ? {} : { pullRequest }),
    updatedAt: at,
  }
}

/**
 * The fact cards one installation keeps: a file per ticket under `root`, and the copy already read, so the
 * prompt section can render it synchronously on a request that must not wait for the disk.
 */
export class FactCards {
  private readonly cards = new Map<string, TicketFacts>()

  constructor(private readonly root: string) {}

  /** Where one ticket's card lives. */
  file(ticketId: string): string { return join(this.root, ticketId, 'facts.yaml') }

  /**
   * The card for one ticket, read from disk the first time this process needs it: a host that restarted has no cards
   * in memory, yet the next request still has to read the bounds its Session was started with.
   */
  peek(ticketId: string): TicketFacts | undefined {
    const remembered = this.cards.get(ticketId)
    if (remembered) return remembered
    const file = this.file(ticketId)
    if (!existsSync(file)) return undefined
    try {
      const facts = parseFacts(readFileSync(file, 'utf8'))
      if (facts !== undefined) this.cards.set(ticketId, facts)
      return facts
    } catch { return undefined }
  }

  /**
   * Keep a card for the prompt section before the disk write finishes: a Ticket's worker asks for its first
   * request in the same tick that creates it, so a card that waits for `write` misses that prompt for good.
   */
  remember(facts: TicketFacts): void { this.cards.set(facts.ticketId, facts) }

  /** Write a card, replacing any earlier one, and keep it for the prompt section. */
  async write(facts: TicketFacts): Promise<void> {
    const file = this.file(facts.ticketId)
    await mkdir(dirname(file), { recursive: true })
    const temporary = `${file}.${process.pid}.tmp`
    await writeFile(temporary, serializeFacts(facts), 'utf8')
    await rename(temporary, file)
    this.remember(facts)
  }

  /** Read a ticket's card from disk and remember it; `undefined` when the ticket has none yet. */
  async read(ticketId: string): Promise<TicketFacts | undefined> {
    const remembered = this.cards.get(ticketId)
    if (remembered) return remembered
    try {
      const facts = parseFacts(await readFile(this.file(ticketId), 'utf8'))
      if (facts) this.cards.set(ticketId, facts)
      return facts
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }
}
