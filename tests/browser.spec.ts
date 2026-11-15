/** The accessibility tree as an agent reads it, and the cost it saves against a screenshot. */
import { describe, expect, it } from 'vitest'
import { estimateTokens, quote, readAriaTree, renderAriaTree, screenshotTokens, type AriaNode } from '../src/app/browser.ts'

const node = (id: string, role: string, name: string, more: Partial<AriaNode> = {}): AriaNode => ({
  nodeId: id, ignored: false, role, name, childIds: [], ...more,
})

describe('the accessibility tree as text', () => {
  it('prints roles and names as YAML, with a ref only on the nodes an agent may act on', () => {
    const nodes = [
      node('1', 'RootWebArea', 'Find a thing', { childIds: ['2', '3', '4'] }),
      node('2', 'heading', 'Find a thing', { properties: { level: 1 } }),
      node('3', 'textbox', 'Query', { backendDOMNodeId: 30, value: 'hello' }),
      node('4', 'button', 'Search', { backendDOMNodeId: 40 }),
    ]
    const rendered = renderAriaTree(nodes, '1')
    expect(rendered.text).toBe([
      '- RootWebArea "Find a thing"',
      '  - heading "Find a thing" level=1',
      '  - textbox "Query" [ref=e1] value="hello"',
      '  - button "Search" [ref=e2]',
      '',
    ].join('\n'))
    expect([...rendered.refs]).toEqual([['e1', 30], ['e2', 40]])
  })

  it('skips ignored nodes but keeps their children, so a wrapper never hides the answer', () => {
    const nodes = [
      node('1', 'RootWebArea', '', { childIds: ['2'] }),
      node('2', 'generic', '', { ignored: true, childIds: ['3'] }),
      node('3', 'StaticText', '3 results for hello'),
    ]
    expect(renderAriaTree(nodes, '1').text).toBe([
      '- RootWebArea ""',
      '  - StaticText "3 results for hello"',
      '',
    ].join('\n'))
  })

  it('quotes a name onto one line, whatever it contains', () => {
    expect(quote('a "b" \\ c\nd')).toBe('"a \\"b\\" \\\\ c\\nd"')
    const nodes = [node('1', 'RootWebArea', 'x', { childIds: ['2'] }), node('2', 'button', 'say "hi"\nthere', { backendDOMNodeId: 7 })]
    expect(renderAriaTree(nodes, '1').text).toContain('- button "say \\"hi\\"\\nthere" [ref=e1]')
  })

  it('stops at maxChars and says how much it left out', () => {
    const children = Array.from({ length: 40 }, (_, index) => node(`c${index}`, 'StaticText', `line ${index} `.repeat(4)))
    const nodes = [node('1', 'RootWebArea', '', { childIds: children.map(child => child.nodeId) }), ...children]
    const rendered = renderAriaTree(nodes, '1', { maxChars: 200 })
    expect(rendered.text.length).toBeLessThanOrEqual(260)
    expect(rendered.text).toContain('truncated')
  })

  it('reads the DevTools payload into the same shape, dropping properties it cannot print', () => {
    const { nodes, rootId } = readAriaTree({ nodes: [
      { nodeId: '1', ignored: false, role: { value: 'RootWebArea' }, name: { value: 'Page' }, childIds: ['2'],
        properties: [{ name: 'hidden', value: { value: false } }, { name: 'focusable', value: { value: true } }] },
      { nodeId: '2', ignored: false, role: { value: 'textbox' }, name: { value: 'Query' }, value: { value: 'hello' },
        backendDOMNodeId: 30, childIds: [] },
    ] })
    expect(rootId).toBe('1')
    expect(nodes[0]?.properties).toEqual({ hidden: false, focusable: true })
    expect(nodes[1]).toMatchObject({ role: 'textbox', name: 'Query', value: 'hello', backendDOMNodeId: 30 })
  })
})

describe('the cost of looking', () => {
  it('counts a text by characters and a screenshot by pixels', () => {
    expect(estimateTokens('x'.repeat(35))).toBe(10)
    expect(estimateTokens('')).toBe(0)
    expect(screenshotTokens(1280, 720)).toBe(1229)
  })

  it('spends far less on a tree than on the screenshot it stands in for', () => {
    const nodes = [
      node('1', 'RootWebArea', 'Find a thing', { childIds: ['2', '3', '4'] }),
      node('2', 'heading', 'Find a thing'),
      node('3', 'textbox', 'Query', { backendDOMNodeId: 30 }),
      node('4', 'button', 'Search', { backendDOMNodeId: 40 }),
    ]
    const aria = estimateTokens(renderAriaTree(nodes, '1').text)
    const image = screenshotTokens(1280, 720)
    expect(aria).toBeLessThan(image * 0.4)
  })
})
