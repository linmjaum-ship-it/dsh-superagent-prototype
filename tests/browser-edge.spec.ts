/** A page driven the way an Executor Session would drive it: look, type, click, read the answer — no screenshot anywhere. */
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { browserExecutable, ChromiumBrowser, type AriaSnapshot } from '../src/app/browser.ts'

const PAGE = `<!doctype html><html><head><title>Find a thing</title></head><body>
<h1>Find a thing</h1>
<label for="q">Query</label><input id="q" aria-label="Query">
<button id="go">Search</button>
<h2>Results</h2><div id="out">nothing yet</div>
<script>
  document.getElementById('go').addEventListener('click', () => {
    document.getElementById('out').textContent = '3 results for ' + document.getElementById('q').value
  })
</script></body></html>`

let opened: ChromiumBrowser | undefined
let server: Server | undefined

const refOf = (snapshot: AriaSnapshot, role: string, name: string): string => {
  const match = new RegExp(`- ${role} "${name}" \\[ref=(e\\d+)\\]`).exec(snapshot.text)
  if (match === null) throw new Error(`No ${role} named ${name} in:\n${snapshot.text}`)
  return match[1]!
}

describe.skipIf(browserExecutable() === undefined)('a page through the accessibility tree', () => {
  afterEach(async () => {
    await opened?.close()
    opened = undefined
    await new Promise<void>(resolve => { if (server === undefined) resolve(); else server.close(() => resolve()) })
    server = undefined
  })

  it('finishes a three-step task for a fraction of a screenshot', async () => {
    server = createServer((request, response) => {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE)
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('the page did not take a port')

    opened = await ChromiumBrowser.launch({ timeoutMs: 30_000 })
    const land = await opened.open(`http://127.0.0.1:${address.port}/`)
    expect(land.title).toBe('Find a thing')
    expect(land.text).toContain('- heading "Find a thing" level=1')

    const filled = await opened.type(refOf(land, 'textbox', 'Query'), 'hello')
    expect(filled.text).toContain('value="hello"')

    const answered = await opened.click(refOf(filled, 'button', 'Search'))
    expect(answered.text).toContain('3 results for hello')

    // The point of the tree: the whole task costs a fraction of one screenshot of the same page.
    expect(answered.cost.screenshot).toBeGreaterThan(0)
    expect(answered.cost.aria).toBeLessThan(answered.cost.screenshot * 0.4)
  }, 90_000)
})
