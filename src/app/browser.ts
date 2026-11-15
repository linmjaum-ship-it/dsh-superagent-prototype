/**
 * A browser for an Executor Session, driven by the accessibility tree instead of screenshots.
 *
 * The tree is what assistive technology reads: roles, names, values and a stable ref per node. It costs a fraction of a
 * screenshot's tokens, so an agent can look, decide and act for far less than a vision loop, and the text is diffable.
 *
 * The page runs in the Chromium already installed on the machine (Edge or Chrome), reached over the DevTools protocol with
 * Node's own WebSocket: no second browser download, and nothing about it is hidden from an operator who watches the port.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** One node of the accessibility tree, the parts a reader decides on. */
export interface AriaNode {
  readonly nodeId: string
  readonly ignored: boolean
  readonly role: string
  readonly name: string
  readonly value?: string
  readonly backendDOMNodeId?: number
  readonly properties?: Readonly<Record<string, string | number | boolean>>
  readonly childIds: readonly string[]
}

/** A rendered view of a page: the text an agent reads, plus the refs it may act on. */
export interface AriaSnapshot {
  readonly url: string
  readonly title: string
  readonly text: string
  readonly refs: ReadonlyMap<string, number>
  /** The tokens the text costs, against what a 1280x720 screenshot of the same page would cost. */
  readonly cost: { readonly aria: number; readonly screenshot: number }
}

/** The operations an agent needs from a page: look, then act by ref, then look again. */
export interface AriaBrowser {
  open(url: string): Promise<AriaSnapshot>
  snapshot(): Promise<AriaSnapshot>
  click(ref: string): Promise<AriaSnapshot>
  type(ref: string, text: string): Promise<AriaSnapshot>
  close(): Promise<void>
}

/** Roles an agent can act on; only these carry a ref, so the text stays small. */
const INTERACTIVE = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch',
  'menuitem', 'menuitemcheckbox', 'menuitemradio', 'tab', 'option', 'slider', 'spinbutton', 'listbox', 'treeitem'])

/** Roles worth printing even though an agent cannot act on them: they carry the page's answer. */
const CONTENT = new Set(['heading', 'paragraph', 'StaticText', 'text', 'list', 'listitem', 'table', 'row', 'cell',
  'columnheader', 'rowheader', 'img', 'image', 'alert', 'status', 'dialog', 'region', 'form', 'navigation', 'main',
  'search', 'article', 'code', 'pre', 'separator'])

const QUOTE = /["\\\n\r\t]/g
const ESCAPES: Record<string, string> = { '"': '\\"', '\\': '\\\\', '\n': '\\n', '\r': '\\r', '\t': '\\t' }

/** Quotes a name so one node stays one line, whatever it contains. */
export function quote(text: string): string {
  return `"${text.replace(QUOTE, match => ESCAPES[match]!)}"`
}

/** Renders the tree under `rootId` as indented YAML, with `e1`-style refs on the nodes an agent may act on. */
export function renderAriaTree(nodes: readonly AriaNode[], rootId: string, options: { maxChars?: number } = {}): { text: string; refs: Map<string, number> } {
  const byId = new Map(nodes.map(node => [node.nodeId, node]))
  const refs = new Map<string, number>()
  const lines: string[] = []
  let chars = 0
  const limit = options.maxChars ?? 12_000
  const walk = (nodeId: string, depth: number, parentName = ''): void => {
    if (chars >= limit || depth > 12) return
    const node = byId.get(nodeId)
    if (!node) return
    // A Text node under a line that already printed the same words adds cost and nothing to read.
    const redundant = node.role === 'StaticText' || node.role === 'text'
    const line = node.ignored || node.role === 'InlineTextBox' || node.role === 'LineBreak' || (redundant && node.name === parentName)
      ? undefined : lineOf(node, refs)
    if (line !== undefined) {
      const text = `${'  '.repeat(depth)}- ${line}\n`
      if (chars + text.length > limit) {
        lines.push(`${'  '.repeat(depth)}- text "... truncated: ${nodes.length - lines.length} more nodes"\n`)
        chars = limit
        return
      }
      lines.push(text)
      chars += text.length
    }
    for (const child of node.childIds) walk(child, line !== undefined ? depth + 1 : depth, node.name)
  }
  walk(rootId, 0)
  return { text: lines.join(''), refs }
}

/** One node as a YAML line, assigning a ref when an agent could act on it; undefined for nodes not worth printing. */
function lineOf(node: AriaNode, refs: Map<string, number>): string | undefined {
  const actable = INTERACTIVE.has(node.role) && node.backendDOMNodeId !== undefined
  if (!actable && !CONTENT.has(node.role) && node.role !== 'RootWebArea') {
    return node.name === '' ? undefined : `${node.role} ${quote(node.name)}`
  }
  const parts = [actable ? `${node.role} ${quote(node.name)} [ref=e${refs.size + 1}]` : `${node.role} ${quote(node.name)}`]
  if (node.value !== undefined && node.value !== '') parts.push(`value=${quote(node.value)}`)
  for (const [name, value] of Object.entries(node.properties ?? {})) {
    if (value === '' || value === false) continue
    parts.push(value === true ? name : `${name}=${typeof value === 'number' ? value : quote(value)}`)
  }
  if (actable) refs.set(`e${refs.size + 1}`, node.backendDOMNodeId!)
  return parts.join(' ')
}

/** Roughly the tokens a model spends on a text of this length: about 3.5 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3.5)
}

/** What a screenshot of this viewport costs, at the usual width*height/750 image-token rule. */
export function screenshotTokens(width: number, height: number): number {
  return Math.ceil((width * height) / 750)
}

/** Reads the CDP accessibility payload into the nodes this module renders. */
export function readAriaTree(raw: unknown): { nodes: AriaNode[]; rootId: string } {
  const payload = raw as { nodes?: unknown }
  const list = Array.isArray(payload.nodes) ? payload.nodes : []
  const nodes: AriaNode[] = []
  for (const item of list) {
    const node = item as Record<string, unknown>
    const role = (node.role as { value?: unknown } | undefined)?.value
    const name = (node.name as { value?: unknown } | undefined)?.value
    const value = (node.value as { value?: unknown } | undefined)?.value
    const properties: Record<string, string | number | boolean> = {}
    for (const property of (node.properties as { name: string; value: { value?: unknown } }[] | undefined) ?? []) {
      const held = property.value.value
      if (typeof held === 'string' || typeof held === 'number' || typeof held === 'boolean') properties[property.name] = held
    }
    nodes.push({
      nodeId: String(node.nodeId),
      ignored: node.ignored === true,
      role: typeof role === 'string' ? role : 'generic',
      name: typeof name === 'string' ? name : '',
      ...(typeof value === 'string' && value !== '' ? { value } : {}),
      ...(typeof node.backendDOMNodeId === 'number' ? { backendDOMNodeId: node.backendDOMNodeId } : {}),
      ...(Object.keys(properties).length ? { properties } : {}),
      childIds: ((node.childIds as unknown[] | undefined) ?? []).map(String),
    })
  }
  return { nodes, rootId: nodes[0]?.nodeId ?? '' }
}

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
}

/** One WebSocket to a DevTools target, with request ids and event listeners: the whole of the CDP client we need. */
class Cdp {
  private next = 0
  private readonly pending = new Map<number, Pending>()
  private readonly events = new Map<string, (params: unknown) => void>()
  private constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: unknown; result?: unknown; error?: { message?: string } }
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id)
        if (!entry) return
        this.pending.delete(message.id)
        if (message.error) entry.reject(new Error(message.error.message ?? 'DevTools refused the call'))
        else entry.resolve(message.result)
        return
      }
      if (message.method !== undefined) this.events.get(message.method)?.(message.params)
    })
  }

  /** Connects to one target's WebSocket and waits for the handshake. */
  static async connect(url: string, timeoutMs = 15_000): Promise<Cdp> {
    const socket = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`DevTools did not answer at ${url} within ${timeoutMs}ms`)), timeoutMs)
      socket.addEventListener('open', () => { clearTimeout(timer); resolve() }, { once: true })
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error(`DevTools refused the connection at ${url}`)) }, { once: true })
    })
    return new Cdp(socket)
  }

  send<T = unknown>(method: string, params: object = {}): Promise<T> {
    const id = ++this.next
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: value => resolve(value as T), reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  /** Resolves on the next `event`, or after `timeoutMs` so a page that fires nothing cannot hang the caller. */
  wait(event: string, timeoutMs: number): Promise<void> {
    return new Promise(resolve => {
      const timer = setTimeout(() => { this.events.delete(event); resolve() }, timeoutMs)
      this.events.set(event, () => { clearTimeout(timer); this.events.delete(event); resolve() })
    })
  }

  close(): void {
    this.events.clear()
    for (const entry of this.pending.values()) entry.reject(new Error('The browser closed'))
    this.pending.clear()
    this.socket.close()
  }
}

/** Where Chromium lives on this machine; `DSH_SUPERAGENT_BROWSER_EXE` overrides it. */
export function browserExecutable(candidates: readonly string[] = DEFAULT_BROWSERS): string | undefined {
  const chosen = process.env.DSH_SUPERAGENT_BROWSER_EXE
  if (chosen !== undefined && existsSync(chosen)) return chosen
  return candidates.find(candidate => existsSync(candidate))
}

const DEFAULT_BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
]

export interface LaunchOptions {
  /** The Chromium binary; defaults to the one this machine already has. */
  readonly executable?: string
  /** A page size for the cost comparison; defaults to 1280x720. */
  readonly viewport?: { width: number; height: number }
  /** How long a navigation may take before the caller is told it did not finish. */
  readonly timeoutMs?: number
}

/**
 * A page in the installed Chromium, reached over the DevTools protocol.
 *
 * It launches one headless browser per page, with its own throwaway profile, because a worker never needs more, and a
 * browser that outlives the ticket would be exactly the kind of access T07 has to isolate.
 */
export class ChromiumBrowser implements AriaBrowser {
  private child: ChildProcess | undefined
  private profile: string | undefined
  private cdp: Cdp | undefined
  private port = 0
  private view = { width: 1280, height: 720 }

  private constructor(private readonly options: LaunchOptions) {}

  /** Launches the browser and connects to a fresh page; call `close` whatever happens next. */
  static async launch(options: LaunchOptions = {}): Promise<ChromiumBrowser> {
    const browser = new ChromiumBrowser(options)
    await browser.start()
    return browser
  }

  private async start(): Promise<void> {
    const executable = this.options.executable ?? browserExecutable()
    if (executable === undefined) throw new Error('No Chromium was found to drive a page with; set DSH_SUPERAGENT_BROWSER_EXE')
    this.profile = await mkdtemp(join(tmpdir(), 'dsh-browser-'))
    const view = this.options.viewport ?? { width: 1280, height: 720 }
    this.child = spawn(executable, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--mute-audio', `--window-size=${view.width},${view.height}`, '--remote-debugging-port=0',
      `--user-data-dir=${this.profile}`, 'about:blank'],
    { stdio: 'ignore', windowsHide: true })
    this.child.on('error', () => { /* a gone browser fails the call that needs it, see the timeout below */ })
    this.port = await this.activePort()
    const target = await this.newTarget()
    this.cdp = await Cdp.connect(target)
    await this.cdp.send('Page.enable')
    await this.cdp.send('Accessibility.enable')
    this.view = this.options.viewport ?? await this.viewport()
  }

  /** The port the browser chose, read from the file it writes once its DevTools endpoint is up. */
  private async activePort(): Promise<number> {
    const file = join(this.profile!, 'DevToolsActivePort')
    const deadline = Date.now() + (this.options.timeoutMs ?? 20_000)
    for (;;) {
      try {
        const [line] = (await readFile(file, 'utf8')).split('\n')
        const port = Number(line)
        if (Number.isInteger(port) && port > 0) return port
      } catch { /* not written yet */ }
      if (Date.now() > deadline) throw new Error('The browser did not open a DevTools port in time')
      await sleep(100)
    }
  }

  /** Opens one blank page and returns its own WebSocket, so no session ids are needed anywhere. */
  private async newTarget(): Promise<string> {
    const response = await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' })
    const page = await response.json() as { webSocketDebuggerUrl?: string }
    if (page.webSocketDebuggerUrl === undefined) throw new Error('The browser opened no page to drive')
    return page.webSocketDebuggerUrl
  }

  private async viewport(): Promise<{ width: number; height: number }> {
    const metrics = await this.cdp!.send<{ cssLayoutViewport?: { clientWidth?: number; clientHeight?: number } }>('Page.getLayoutMetrics')
    const width = metrics.cssLayoutViewport?.clientWidth
    const height = metrics.cssLayoutViewport?.clientHeight
    return { width: typeof width === 'number' && width > 0 ? width : 1280, height: typeof height === 'number' && height > 0 ? height : 720 }
  }

  async open(url: string): Promise<AriaSnapshot> {
    const loaded = this.cdp!.wait('Page.loadEventFired', this.options.timeoutMs ?? 20_000)
    await this.cdp!.send('Page.navigate', { url })
    await loaded
    return this.snapshot()
  }

  async snapshot(): Promise<AriaSnapshot> {
    const tree = readAriaTree(await this.cdp!.send('Accessibility.getFullAXTree'))
    const rendered = renderAriaTree(tree.nodes, tree.rootId)
    const page = await this.cdp!.send<{ frameTree?: { frame?: { url?: string } } }>('Page.getFrameTree')
    const evaluated = await this.cdp!.send<{ result?: { value?: unknown } }>('Runtime.evaluate', { expression: 'document.title', returnByValue: true })
    const text = rendered.text
    return { url: page.frameTree?.frame?.url ?? '', title: typeof evaluated.result?.value === 'string' ? evaluated.result.value : '',
      text, refs: rendered.refs, cost: { aria: estimateTokens(text), screenshot: screenshotTokens(this.view.width, this.view.height) } }
  }

  async click(ref: string): Promise<AriaSnapshot> {
    await this.call(ref, 'function () { this.scrollIntoView({ block: "center", inline: "center" }); this.click(); return true }', [])
    await sleep(250)
    return this.snapshot()
  }

  async type(ref: string, text: string): Promise<AriaSnapshot> {
    await this.call(ref, 'function (value) { this.focus(); const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value")?.set; if (setter) setter.call(this, value); else this.value = value; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); return true }', [text])
    return this.snapshot()
  }

  /** Resolves a ref to its element and runs one function on it. */
  private async call(ref: string, declaration: string, args: readonly string[]): Promise<void> {
    const snapshot = await this.snapshot()
    const backend = snapshot.refs.get(ref)
    if (backend === undefined) throw new Error(`The page has no ${ref}; take a snapshot and use one of its refs`)
    const { object } = await this.cdp!.send<{ object?: { objectId?: string } }>('DOM.resolveNode', { backendNodeId: backend })
    if (object?.objectId === undefined) throw new Error(`The element behind ${ref} is no longer in the page; take a snapshot again`)
    const result = await this.cdp!.send<{ exceptionDetails?: { text?: string } }>('Runtime.callFunctionOn', {
      objectId: object.objectId,
      functionDeclaration: declaration,
      arguments: args.map(value => ({ value })),
      returnByValue: true,
      awaitPromise: false,
    })
    if (result.exceptionDetails !== undefined) throw new Error(`The page refused the action on ${ref}: ${result.exceptionDetails.text ?? 'unknown error'}`)
  }

  async close(): Promise<void> {
    this.cdp?.close()
    this.cdp = undefined
    try { await fetch(`http://127.0.0.1:${this.port}/json/close`, { method: 'GET' }) } catch { /* the browser may be gone already */ }
    this.child?.kill()
    if (this.profile !== undefined) await rm(this.profile, { recursive: true, force: true, maxRetries: 3 }).catch(() => {})
    this.profile = undefined
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
