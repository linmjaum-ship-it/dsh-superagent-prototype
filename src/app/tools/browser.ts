import { z } from 'zod'
import type { AriaSnapshot } from '../browser.ts'
import type { BrowserSessions } from '../browser-sessions.ts'
import { tool, type Tool } from './tool.ts'

export const BrowserActionSchema = z.object({
  action: z.enum(['open', 'snapshot', 'click', 'type', 'close']).describe('open visits a url; snapshot reads the page again; click and type act on a ref a snapshot printed; close ends the browser'),
  url: z.string().min(1).optional().describe('The page to visit with open, for example "http://127.0.0.1:3082/orchestrator/api/overview"'),
  ref: z.string().min(1).optional().describe('The handle of an element a snapshot printed, such as "e12"'),
  text: z.string().optional().describe('What to put in the field addressed by ref when the action is type'),
}).strict()

export type BrowserAction = z.infer<typeof BrowserActionSchema>

/**
 * Refuses a page the browser could not load. Chrome reports a navigation that never reached a server as its own
 * error page, whose url starts with `chrome-error://`; reading that tree would tell the worker a page exists that
 * never loaded, so it counts as a failure and feeds the streak the tool watches.
 */
function loaded(snapshot: AriaSnapshot): AriaSnapshot {
  if (!snapshot.url.startsWith('chrome-error://')) return snapshot
  const said = snapshot.text.split('\n').map(line => line.replace(/^\s*-\s*/, '').trim()).filter(line => line !== '').slice(0, 4).join('; ')
  throw new Error(`the browser could not load the page: ${said}`)
}

/** What a worker sees of a page: the accessibility tree, its refs, and what a screenshot of the same page would cost. */
function page(snapshot: AriaSnapshot): Record<string, unknown> {
  loaded(snapshot)
  return {
    url: snapshot.url,
    title: snapshot.title,
    text: snapshot.text,
    tokens: { aria: snapshot.cost.aria, screenshot: snapshot.cost.screenshot },
    saved: `${Math.max(0, Math.round((1 - snapshot.cost.aria / snapshot.cost.screenshot) * 100))}% fewer tokens than a screenshot`,
  }
}

/** How many page actions in a row may fail before the tool stops and asks the worker to hand the work back. */
const BEATEN_TIMES = 3

/**
 * Drives one headless browser for a ticket through the accessibility tree instead of screenshots.
 *
 * The tree is what a screen reader reads: roles, names, values and a short handle per control, which costs a
 * fraction of the tokens a screenshot spends and cannot be misread as a picture of a page that never existed.
 *
 * A page that keeps refusing the same ticket is a page a person should look at: after {@link BEATEN_TIMES}
 * failures in a row the error itself says so and names the tool that hands the work back, because a worker
 * retrying forever costs tokens and never reaches the answer.
 */
export function browserTool(sessions: BrowserSessions, ticketId: string): Tool {
  const act = async (args: BrowserAction): Promise<unknown> => {
    if (args.action === 'close') {
      await sessions.close(ticketId)
      return { closed: true }
    }
    if (args.action === 'open') {
      if (args.url === undefined) throw new Error('open needs the url of the page to visit')
      const browser = await sessions.page(ticketId)
      return page(await browser.open(args.url))
    }
    if (!sessions.running(ticketId)) throw new Error('No page is open for this ticket; open one first')
    const browser = await sessions.page(ticketId)
    if (args.action === 'snapshot') return page(await browser.snapshot())
    if (args.ref === undefined) throw new Error(`${args.action} needs the ref a snapshot printed, such as e12`)
    if (args.action === 'click') return page(await browser.click(args.ref))
    if (args.text === undefined) throw new Error(`type needs the text to put in ${args.ref}`)
    return page(await browser.type(args.ref, args.text))
  }

  return tool({
    name: 'orchestrator_browser',
    description: 'Drives one headless browser for this ticket: open a page, then click or type using the [ref=eN] handles a snapshot printed, and read the result back as text. Prefer this over asking a person what a page says.',
    schema: BrowserActionSchema,
    execute: async (args: BrowserAction) => {
      try {
        const done = await act(args)
        sessions.recovered(ticketId)
        return done
      } catch (error) {
        const count = sessions.beaten(ticketId)
        const reason = error instanceof Error ? error.message : String(error)
        if (count < BEATEN_TIMES) throw new Error(reason)
        // A routine's Trigger became this ticket rather than reaching it as an Input, so hand-back refuses it: the
        // report is the step that reaches a person for every kind of ticket.
        throw new Error(`${reason} This ticket's page has beaten us ${count} times: stop taking steps and report back with orchestrator_report in state blocked, saying what you tried and what the page did, and ask for a person with human_action; a message that asks for work beyond this ticket is handed back with orchestrator_trigger_handback instead.`)
      }
    },
  })
}
