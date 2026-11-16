import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { composePrompt, defaultPrompts, policySection } from '../src/app/prompts.ts'
import type { Settings } from '../src/policy.ts'

/**
 * Prompt caching only pays off while the prompt head is byte-identical from the first token: one edited word above the
 * generated sections and every turn of every Session re-prices the whole prefix as fresh input. These tests pin the head
 * so an accidental edit shows up here, and pin the assembly order so per-Ticket and Policy text stays below the head.
 */
const digest = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The head as of 2026-11-15. After an intentional edit, measure the next real turn in `$STATE/usage.jsonl` before updating. */
const HEAD_SHA256 = {
  orchestrator: '871f84533bd88c00d8f21d1648513820b3c8b7231a33aea1ee886f075f6d6de2',
  worker: '35af91d55cec944745cc984779526c0c42cd9548e36443876a728419540d1d7c',
} as const

it('keeps the prompt head byte-identical, so a warm prefix stays cached', () => {
  for (const role of ['orchestrator', 'worker'] as const) {
    expect(digest(composePrompt(defaultPrompts(), role)), `The ${role} system prompt head changed. A change here re-prices the `
      + 'whole prefix for every Session, so check the next real turn in $STATE/usage.jsonl before updating HEAD_SHA256.')
      .toBe(HEAD_SHA256[role])
  }
})

it('appends the generated sections after the head, so a per-Ticket value never moves the head', () => {
  const config = defaultPrompts()
  const base = composePrompt(config, 'orchestrator')
  const environment = '- DSH_SUPERAGENT_DIR = "/srv/work/fix-1": This ticket\'s directory.'
  const policy = policySection({ policy: { rules: [] }, eval: { mode: 'shadow' } } as unknown as Settings, config)
  const withEnvironment = composePrompt(config, 'orchestrator', environment)
  const withPolicy = composePrompt(config, 'orchestrator', environment, policy)
  expect(withEnvironment.startsWith(base)).toBe(true)
  expect(withPolicy.startsWith(base)).toBe(true)
  expect(withPolicy.endsWith(policy.text)).toBe(true)
  // The environment and the Policy differ per Ticket and per settings revision; the head above them does not.
  expect(composePrompt(config, 'orchestrator', 'other')).not.toBe(withEnvironment)
  expect(withPolicy.length).toBe(withEnvironment.length + 2 + policy.text.length)
})

it('falls over when a sentence is inserted at the head, which is what makes the pin bite', () => {
  const config = defaultPrompts()
  const head = composePrompt(config, 'orchestrator')
  const edited = { ...config, scope: `A brand new sentence at the head.\n${config.scope}` }
  expect(digest(composePrompt(edited, 'orchestrator'))).not.toBe(digest(head))
})
