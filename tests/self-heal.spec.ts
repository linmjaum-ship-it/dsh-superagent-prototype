import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SelfHeal, type ArchiveRegistry } from '../src/app/self-heal.ts'

const dirs: string[] = []
const stateDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'self-heal-'))
  dirs.push(dir)
  return dir
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

const now = () => new Date('2026-11-15T00:00:00.000Z')

describe('SelfHeal', () => {
  it('unarchives the master Session, drops it from the registry, and audits the repair', async () => {
    const dir = stateDir()
    const ids = ['orchestrator-a', 'other']
    const removed: string[] = []
    const workspace: ArchiveRegistry = {
      get archivedSessionIds() { return ids },
      async unarchiveSession(id: string) { removed.push(id); ids.splice(ids.indexOf(id), 1) },
    }
    const heal = new SelfHeal({ masterId: 'orchestrator-a', stateDir: dir, workspace, enabled: true, now })
    await expect(heal.heal('wake ended without a model request')).resolves.toBe('unarchived')
    expect(removed).toEqual(['orchestrator-a'])
    expect(ids).toEqual(['other'])
    const audit = readFileSync(join(dir, 'self-heal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(audit.map(entry => entry.action)).toEqual(['unarchive', 'unarchive'])
    expect(audit[1].outcomes).toBe('unarchived')
    expect(audit[1].reason).toBe('wake ended without a model request')
  })
  it('copies the registry file aside before it repairs, and names the copy in the audit', async () => {
    const dir = stateDir()
    const registry = join(dir, 'workspace.json')
    writeFileSync(registry, JSON.stringify({ global: { archivedSessionIds: ['orchestrator-a'] } }))
    const ids = ['orchestrator-a']
    const workspace: ArchiveRegistry = {
      get archivedSessionIds() { return ids },
      async unarchiveSession() { ids.splice(0) },
    }
    const heal = new SelfHeal({ masterId: 'orchestrator-a', stateDir: dir, workspace, registryPath: registry, enabled: true, now })
    await expect(heal.heal('blocked')).resolves.toBe('unarchived')
    const audit = readFileSync(join(dir, 'self-heal.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    const backup = audit[0].backup as string
    expect(existsSync(backup)).toBe(true)
    expect(backup.startsWith(`${registry}.bak-selfheal-`)).toBe(true)
    expect(JSON.parse(readFileSync(backup, 'utf8')).global.archivedSessionIds).toEqual(['orchestrator-a'])
  })
  it('leaves an unarchived Session alone', async () => {
    const removed: string[] = []
    const workspace: ArchiveRegistry = {
      archivedSessionIds: ['other'],
      async unarchiveSession(id: string) { removed.push(id) },
    }
    const heal = new SelfHeal({ masterId: 'orchestrator-a', stateDir: stateDir(), workspace, enabled: true, now })
    await expect(heal.heal('blocked')).resolves.toBe('not-archived')
    expect(removed).toEqual([])
  })
  it('repairs at most once per five minutes for the same Session', async () => {
    let at = now()
    const ids = ['orchestrator-a']
    const workspace: ArchiveRegistry = {
      get archivedSessionIds() { return ids },
      async unarchiveSession() { ids.splice(0) },
    }
    const heal = new SelfHeal({ masterId: 'orchestrator-a', stateDir: stateDir(), workspace, enabled: true, now: () => at })
    await expect(heal.heal('blocked')).resolves.toBe('unarchived')
    ids.push('orchestrator-a')
    await expect(heal.heal('blocked again')).resolves.toBe('throttled')
    at = new Date(at.getTime() + 5 * 60_000)
    await expect(heal.heal('blocked again')).resolves.toBe('unarchived')
    expect(ids).toEqual([])
  })
  it('does nothing when an operator turned automatic repair off', async () => {
    const removed: string[] = []
    const workspace: ArchiveRegistry = {
      archivedSessionIds: ['orchestrator-a'],
      async unarchiveSession(id: string) { removed.push(id) },
    }
    const heal = new SelfHeal({ masterId: 'orchestrator-a', stateDir: stateDir(), workspace, enabled: false, now })
    await expect(heal.heal('blocked')).resolves.toBe('disabled')
    expect(removed).toEqual([])
  })
})
