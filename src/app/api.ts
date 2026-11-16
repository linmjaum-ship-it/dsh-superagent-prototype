/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'
import type { UsageGroup, UsageTotals } from './usage.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

/** What the cost panel reads: the tokens the managed Sessions spent today and over the last day. */
export interface UsageView {
  readonly today: UsageTotals
  readonly last24Hours: UsageTotals
  /** The Sessions of the last day, most expensive first, so the panel can say where the money went. */
  readonly bySession: UsageGroup[]
  /** Why today's prompt cache is not paying off, when it is not; absent while the cache works or too little has run. */
  readonly alert?: string
}

/** A schedule the agent runs on its own; a fire is an inferred candidate the accept mode decides on. */
export interface RoutineView {
  readonly id: string
  readonly name: string
  readonly cron: string
  readonly prompt: string
  readonly enabled: boolean
  readonly createdAt: string
  readonly lastAt?: string
  readonly nextAt: string
}

/** A question about one irreversible command, as the panel lists it: what waits, and what a person answered. */
/** How many questions are open and how the closed ones ended, so the panel does not only show what is pending. */
export interface ApprovalTally {
  readonly waiting: number
  readonly approved: number
  readonly rejected: number
  readonly expired: number
  readonly used: number
}

export interface ApprovalView {
  readonly id: string
  readonly ticketId: string
  readonly rule: string
  readonly command: string
  readonly state: 'pending' | 'approved' | 'rejected' | 'expired' | 'used'
  readonly askedAt: string
  readonly expiresAt: string
  readonly decidedAt?: string
  readonly decidedBy?: string
  readonly decidedVia?: 'panel' | 'card'
}

export interface Api {
  'GET state': { response: StateView }
  'GET overview': { response: OverviewView }
  'GET usage': { response: UsageView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  /** Compacts one Ticket's Session now, so a long history shrinks without waiting for the automatic token threshold. */
  'POST tickets/:id/compact': { response: { compacted: boolean } }
  /** Opens one turn on a Ticket's Session for diagnostics, so a compacted history can be read again. */
  'POST tickets/:id/prompt': { body: { text: string }; response: { prompted: true } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  /** Wakes the main Session once, so an operator can tell a refused wake from a missing one. */
  'POST selftest/wake': { response: { woken: true } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET routines': { response: { routines: RoutineView[] } }
  'POST routines': { body: { id?: string; name: string; cron: string; prompt: string; enabled?: boolean }; response: { routine: RoutineView } }
  'POST routines/:id/remove': { response: { removed: boolean } }
  'GET approvals': { response: { approvals: ApprovalView[]; tally: ApprovalTally } }
  'POST approvals/:id/decide': { body: { answer: 'approve' | 'reject' }; response: { approval: ApprovalView } }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
