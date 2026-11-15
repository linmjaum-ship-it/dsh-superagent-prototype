/** On-demand compaction: the seam a long Session uses to shrink its history without waiting for the automatic threshold. */
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'

/**
 * The part of the host's `compaction` service this installation uses. The service comes from the harness, which this
 * package does not depend on, so its shape is declared here: a host that mounts no compaction plugin answers `undefined`
 * rather than failing to load.
 */
export interface CompactionSeam {
  /**
   * Shrink one Session's history now. The host's automatic pass waits for a token threshold a worker rarely reaches inside
   * one Ticket, so an operator who needs the history small sooner asks for it here.
   */
  compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: string): Promise<unknown>
}

/**
 * The host's compaction service, absent on a host that mounts no compaction plugin. Read through `reflect.get`, because
 * the context proxy refuses a plain property read for a service this package does not declare in `inject` — and it must
 * not declare one, since a profile without the compaction plugin would then never start.
 */
export function compactionSeam(ctx: Context): CompactionSeam | undefined {
  return ctx.reflect.get('compaction', false) as CompactionSeam | undefined
}

/**
 * The part of the host's `commands` service this installation uses: a preset that keeps its compaction backend in an
 * isolated realm registers `/compact` there, so the command is the one handle left to that backend from outside it.
 */
export interface CommandSeam {
  execute(agent: Agent, line: string, submittedAttachments: readonly unknown[], signal: AbortSignal): Promise<unknown>
}

/** The host's command runtime, absent on a host that mounts no command service. */
export function commandSeam(ctx: Context): CommandSeam | undefined {
  return ctx.reflect.get('commands', false) as CommandSeam | undefined
}
