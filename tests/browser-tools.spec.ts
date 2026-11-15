import { describe, expect, it } from 'vitest'
import type { AriaBrowser, AriaSnapshot } from '../src/app/browser.ts'
import { BrowserSessions } from '../src/app/browser-sessions.ts'
import { browserTool } from '../src/app/tools/browser.ts'

const snapshot = (text: string): AriaSnapshot => ({
  url: 'http://127.0.0.1:9/', title: 'A page', text, refs: new Map([['e1', 1]]),
  cost: { aria: 10, screenshot: 1_000 },
})

class FakeBrowser implements AriaBrowser {
  readonly visited: string[] = []
  closed = false
  async open(url: string): Promise<AriaSnapshot> { this.visited.push(url); return snapshot('opened') }
  async snapshot(): Promise<AriaSnapshot> { return snapshot('again') }
  async click(ref: string): Promise<AriaSnapshot> { return snapshot(`clicked ${ref}`) }
  async type(ref: string, text: string): Promise<AriaSnapshot> { return snapshot(`typed ${text} into ${ref}`) }
  async close(): Promise<void> { this.closed = true }
}

function sessions(): { sessions: BrowserSessions; launched: FakeBrowser[] } {
  const launched: FakeBrowser[] = []
  return { sessions: new BrowserSessions(async () => { const browser = new FakeBrowser(); launched.push(browser); return browser }), launched }
}

const run = async (tool: ReturnType<typeof browserTool>, args: unknown): Promise<Record<string, unknown>> =>
  await tool.execute(args as never, new AbortController().signal) as Record<string, unknown>

describe('the browser a ticket drives', () => {
  it('launches one browser per ticket and hands the same one back', async () => {
    const { sessions: pool, launched } = sessions()
    const first = await pool.page('ticket-a')
    expect(await pool.page('ticket-a')).toBe(first)
    expect(await pool.page('ticket-b')).not.toBe(first)
    expect(launched).toHaveLength(2)
  })

  it('forgets a browser that was closed, so the next page is a new one', async () => {
    const { sessions: pool, launched } = sessions()
    await pool.page('ticket-a')
    expect(pool.running('ticket-a')).toBe(true)
    await pool.close('ticket-a')
    expect(pool.running('ticket-a')).toBe(false)
    await pool.page('ticket-a')
    expect(launched).toHaveLength(2)
    expect(launched[0]!.closed).toBe(true)
  })
})

describe('orchestrator_browser', () => {
  it('opens a page and reports what a screenshot of it would have cost', async () => {
    const { sessions: pool } = sessions()
    const answer = await run(browserTool(pool, 'ticket-a'), { action: 'open', url: 'http://127.0.0.1:9/' })
    expect(answer.text).toBe('opened')
    expect(answer.tokens).toEqual({ aria: 10, screenshot: 1_000 })
    expect(answer.saved).toBe('99% fewer tokens than a screenshot')
  })

  it('acts on a ref a snapshot printed and reads the result back', async () => {
    const { sessions: pool } = sessions()
    const tool = browserTool(pool, 'ticket-a')
    await run(tool, { action: 'open', url: 'http://127.0.0.1:9/' })
    expect((await run(tool, { action: 'click', ref: 'e1' })).text).toBe('clicked e1')
    expect((await run(tool, { action: 'type', ref: 'e1', text: 'hello' })).text).toBe('typed hello into e1')
    expect((await run(tool, { action: 'snapshot' })).text).toBe('again')
  })

  it('refuses to act before a page is open, and explains what each action needs', async () => {
    const tool = browserTool(sessions().sessions, 'ticket-a')
    await expect(run(tool, { action: 'snapshot' })).rejects.toThrow('No page is open for this ticket; open one first')
    const fresh = browserTool(sessions().sessions, 'ticket-b')
    await expect(run(fresh, { action: 'click', ref: 'e1' })).rejects.toThrow('No page is open for this ticket; open one first')
    await expect(run(fresh, { action: 'open' })).rejects.toThrow('open needs the url of the page to visit')
    await run(fresh, { action: 'open', url: 'http://127.0.0.1:9/' })
    await expect(run(fresh, { action: 'click' })).rejects.toThrow('click needs the ref a snapshot printed, such as e12')
    await expect(run(fresh, { action: 'type', ref: 'e1' })).rejects.toThrow('type needs the text to put in e1')
  })

})

describe('a page that keeps refusing', () => {
  it('counts failures per ticket, so a stranger page is not blamed for this one', async () => {
    const { sessions: pool } = sessions()
    const fail = async (ticketId: string): Promise<string> =>
      await run(browserTool(pool, ticketId), { action: 'snapshot' }).then(
        () => { throw new Error('the page was expected to refuse') },
        (error: unknown) => (error as Error).message,
      )
    await fail('ticket-a')
    await fail('ticket-a')
    // ticket-b has its own streak: one failure there is not the third one here.
    expect(await fail('ticket-b')).not.toContain('orchestrator_trigger_handback')
    expect(await fail('ticket-a')).toContain('beaten us 3 times')
  })

  it('forgets the streak after an action that worked', async () => {
    const { sessions: pool } = sessions()
    const tool = browserTool(pool, 'ticket-a')
    await expect(run(tool, { action: 'snapshot' })).rejects.toThrow('No page is open for this ticket; open one first')
    await run(tool, { action: 'open', url: 'http://127.0.0.1:9/' })
    await expect(run(tool, { action: 'snapshot' })).resolves.toBeDefined()
    // The open worked, so the next failure is the first one again rather than the third.
    await run(tool, { action: 'click' }).catch(() => undefined)
    const message = await run(tool, { action: 'click' }).catch((error: unknown) => (error as Error).message)
    expect(message).toContain('click needs the ref a snapshot printed')
    expect(message).not.toContain('orchestrator_trigger_handback')
  })

  it('tells the worker to hand back after the third failure instead of clicking on', async () => {
    const { sessions: pool } = sessions()
    const tool = browserTool(pool, 'ticket-a')
    const fail = async (): Promise<string> => {
      try {
        await run(tool, { action: 'snapshot' })
        throw new Error('the page was expected to refuse')
      } catch (error) {
        return (error as Error).message
      }
    }
    expect(await fail()).toBe('No page is open for this ticket; open one first')
    expect(await fail()).not.toContain('orchestrator_trigger_handback')
    const third = await fail()
    expect(third).toContain('No page is open for this ticket; open one first')
    expect(third).toContain('beaten us 3 times')
    expect(third).toContain('orchestrator_trigger_handback')
  })
})
