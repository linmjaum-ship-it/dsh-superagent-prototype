// @vitest-environment jsdom
/**
 * Demo harness (added for the showcase, not part of the upstream repository).
 *
 * Mounts the official Superagent panel source (`src/client/app.tsx`) against the
 * official panel test fixtures (`tests/fixtures/panel*.tsx`) and serializes each
 * documented page (docs/005-panel.md tabs) to a self-contained HTML file that
 * includes the panel's own stylesheet and the DSH Web theme tokens captured from
 * the local GUI. Nothing is fetched from the network; the fake management API
 * serves the fixture data only.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { it } from 'vitest'
import { en, zh } from '../src/client/locales.ts'
import { at, click, mount, remount, settle, tab, usePanel } from '../tests/fixtures/panel.tsx'

usePanel()

const OUT = resolve(process.cwd(), 'demo/out')
const TOKENS = readFileSync(resolve(process.cwd(), 'demo/tokens-light.css'), 'utf8')
// `client.css?raw` resolves to an empty string under this vitest setup, so the
// official stylesheet is injected from the same upstream file directly.
const PANEL_CSS = readFileSync(resolve(process.cwd(), 'src/client/client.css'), 'utf8')
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif'
const files: Record<string, { title: string; bytes: number; sha256: string }> = {}

function serialize(name: string, title: string): void {
  const shell = [
    'html,body{margin:0;padding:0;background:var(--dsw-alias-bg-base,#fff);color:var(--dsw-alias-label-primary,#0f1115);',
    `font-family:${FONT};}`,
    // The panel normally scrolls inside a fixed-height host slot; let it grow so a
    // full-page screenshot shows the whole page instead of the first viewport.
    '.dt-page{height:auto!important;overflow:visible!important;min-height:100vh;}',
    '.dt-embedded{height:auto!important;}',
  ].join('')
  const html = [
    '<!doctype html>',
    '<html lang="zh-CN">',
    '<head>',
    '<meta charset="utf-8">',
    `<title>${title}</title>`,
    `<style id="dsh-theme-tokens">${TOKENS}</style>`,
    `<style id="superagent-panel-css">${PANEL_CSS}</style>`,
    `<style id="demo-shell">${shell}</style>`,
    '</head>',
    '<body>',
    document.body.innerHTML,
    '</body>',
    '</html>',
    '',
  ].join('\n')
  const target = resolve(OUT, `${name}.html`)
  writeFileSync(target, html, 'utf8')
  files[`${name}.html`] = { title, bytes: Buffer.byteLength(html), sha256: createHash('sha256').update(html).digest('hex') }
}

it('serializes every documented Superagent panel page from the official source and fixtures', async () => {
  mkdirSync(OUT, { recursive: true })

  // 01 Overview is the panel's home page.
  await mount()
  serialize('01-overview', 'Superagent - 概览 / Overview')

  // 02 Source, 03 Trigger, 04 Eval, 05 Execution, 06 Settings are the remaining tabs.
  await click(tab(zh['tab.source']))
  serialize('02-source', 'Superagent - 来源 / Source')
  await click(tab(zh['tab.trigger']))
  serialize('03-trigger', 'Superagent - 触发 / Trigger')
  await click(tab(zh['tab.eval']))
  serialize('04-eval', 'Superagent - 评估 / Eval')
  await click(tab(zh['tab.execution']))
  serialize('05-execution', 'Superagent - 执行 / Execution')
  await click(tab(zh['tab.settings']))
  serialize('06-settings', 'Superagent - 设置 / Settings')

  // 07 A Trigger Thread page with its timeline, Decisions and Subscriptions.
  at({ page: 'trigger', id: 'feishu:oc_1:om_root' })
  await remount()
  serialize('07-thread', 'Superagent - 触发线程 / Trigger Thread')

  // 08 A Ticket page: authorization, scope, Policy version, Assignments and Inputs.
  at({ page: 'execution', id: 't1' })
  await remount()
  serialize('08-ticket', 'Superagent - 工单 / Ticket')

  // 09 The Eval settings group: allowed lists, admission table and Policy version.
  at({ page: 'settings', query: { group: 'eval' } })
  await remount()
  serialize('09-settings-eval', 'Superagent - 评估设置 / Eval settings')

  // 10 The same Overview in English, so both shipped locales are visible.
  at({ page: 'overview' })
  await remount(en)
  serialize('10-overview-en', 'Superagent - Overview (English)')
  await settle()

  const manifest = {
    generated_at: new Date().toISOString(),
    harness: 'demo/render.spec.tsx',
    source: 'official src/client/app.tsx at the cloned commit, fake management API from tests/fixtures/panel-server.ts',
    locale_default: 'zh',
    pages: files,
  }
  writeFileSync(resolve(OUT, 'render-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
})
