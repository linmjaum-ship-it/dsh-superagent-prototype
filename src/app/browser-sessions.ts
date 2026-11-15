import { ChromiumBrowser, type AriaBrowser } from './browser.ts'

/**
 * One headless browser per ticket, opened on first use and closed by the worker or when the profile stops.
 *
 * A worker's pages belong to the work it was accepted for: a second ticket gets its own browser rather than
 * sharing the cookies and the half-filled form the first one left behind.
 */
export class BrowserSessions {
  private readonly opened = new Map<string, Promise<AriaBrowser>>()

  private readonly beating = new Map<string, number>()

  constructor(private readonly launch: () => Promise<AriaBrowser> = () => ChromiumBrowser.launch()) {}

  /** The browser this ticket drives, launched once and reused until it is closed. */
  page(ticketId: string): Promise<AriaBrowser> {
    const running = this.opened.get(ticketId)
    if (running !== undefined) return running
    const starting = this.launch()
    this.opened.set(ticketId, starting)
    // A launch that failed leaves nothing to reuse: the next call starts a fresh browser instead of the same error.
    starting.catch(() => { if (this.opened.get(ticketId) === starting) this.opened.delete(ticketId) })
    return starting
  }

  /** How many actions in a row this ticket's page has refused, so the tool can stop before a worker keeps clicking into a wall. */
  beaten(ticketId: string): number {
    const count = (this.beating.get(ticketId) ?? 0) + 1
    this.beating.set(ticketId, count)
    return count
  }

  /** Forgets the streak after an action that worked, so one bad click does not follow a worker forever. */
  recovered(ticketId: string): void {
    this.beating.delete(ticketId)
  }

  /** Whether this ticket has a browser running, so a close can be a no-op instead of a launch. */
  running(ticketId: string): boolean {
    return this.opened.has(ticketId)
  }

  async close(ticketId: string): Promise<void> {
    const running = this.opened.get(ticketId)
    if (running === undefined) return
    this.opened.delete(ticketId)
    this.beating.delete(ticketId)
    await (await running.catch(() => undefined))?.close()
  }

  /** Closes every browser, used when the profile stops so no headless process outlives it. */
  async closeAll(): Promise<void> {
    const running = [...this.opened.values()]
    this.opened.clear()
    await Promise.all(running.map(async entry => (await entry.catch(() => undefined))?.close()))
  }
}
