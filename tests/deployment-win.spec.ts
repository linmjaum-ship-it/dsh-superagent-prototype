import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { executable } from '../src/deployment.ts'

/** Windows finds a command through PATHEXT, so the CLI the settings name is `gh.cmd`, not `gh`. */
describe.skipIf(process.platform !== 'win32')('executable on Windows', () => {
  let dir = ''
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'deployment-win-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('finds the batch file PATHEXT puts behind a bare command name', () => {
    const file = join(dir, 'gh.cmd')
    writeFileSync(file, '@echo off\r\n')
    expect(executable('gh', dir)).toBe(file)
  })

  it('finds an .exe and keeps a name that already has an extension as written', () => {
    const exe = join(dir, 'tool.exe')
    writeFileSync(exe, '')
    expect(executable('tool', dir)).toBe(exe)
    expect(executable('tool.exe', dir).toLowerCase()).toBe(exe.toLowerCase())
  })

  it('skips the directory it was told to ignore, and reports a name no directory holds', () => {
    const excluded = join(dir, 'excluded')
    const kept = join(dir, 'kept')
    mkdirSync(excluded)
    mkdirSync(kept)
    writeFileSync(join(excluded, 'gh.cmd'), '@echo off\r\n')
    writeFileSync(join(kept, 'gh.cmd'), '@echo off\r\n')
    expect(executable('gh', `${excluded}${delimiter}${kept}`, excluded)).toBe(join(kept, 'gh.cmd'))
    expect(() => executable('nope', kept)).toThrow('nope is not an executable file on PATH')
  })
})
