import { execFile } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { workerBin, writeEnvironment } from '../src/infra/environment.ts'
import { testDeployment } from './fixtures/deployment.ts'

// A worker's shell on Windows is `cmd.exe`, so these fixtures are batch files and run through it.
vi.setConfig({ testTimeout: 30_000 })
const exec = promisify(execFile)
let dir: string
const batch = (path: string, body: string): string => { writeFileSync(path, `@echo off\r\n${body}\r\n`); return path }
/** The environment a worker's cmd.exe gets: the shim directory first, then the real one. */
const workerEnv = (): Record<string, string> => ({
  SystemRoot: process.env.SystemRoot ?? 'C:\\Windows',
  PATHEXT: '.COM;.EXE;.BAT;.CMD',
  PATH: [workerBin(dir), join(dir, 'real')].join(';'),
})
/** The worker's PATH excludes System32, so cmd.exe has to be named where it lives. */
const shell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
const cmd = async (line: string): Promise<{ stdout: string; stderr: string }> => exec(shell, ['/d', '/c', line], { env: workerEnv(), timeout: 20_000 })
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'environment-win-')); mkdirSync(join(dir, 'real')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe.skipIf(process.platform !== 'win32')('worker shims on Windows', () => {
  it('writes batch shims rather than shell scripts, because no Windows shell runs the latter', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    const bin = workerBin(dir)
    expect(readdirSync(bin).sort()).toEqual(['gh.cmd', 'lark-cli.cmd', 'personal-gh.cmd'])
    const text = readFileSync(join(bin, 'gh.cmd'), 'utf8').split('\n')
    expect(text[0]?.trim()).toBe('@echo off')
    expect(text[1]).toContain('# Written by dsh-superagent')
  })
  it('make a blocked command fail in the worker shell with the agent\'s login', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['personal-gh'])
    await expect(cmd('personal-gh')).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(`personal-gh is blocked in this installation; use gh, which acts as ${testDeployment().github.login}.`),
    })
  })
  it('run `gh` through the shim with the caller\'s arguments, and keep the shim directory off its PATH', async () => {
    // Backslashes are replaced so the line stays valid JSON: a Windows PATH is full of them.
    const gh = batch(join(dir, 'real', 'gh.cmd'), 'echo {"login":"agent-bot","args":"%*","path":"%PATH:\\=/%"}')
    const base = testDeployment()
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined, github: { ...base.github, login: 'agent-bot', cli: gh } }), [])
    const { stdout } = await cmd('gh api user --jq .login')
    const seen = JSON.parse(stdout) as { login: string; args: string; path: string }
    expect(seen.login).toBe('agent-bot')
    expect(seen.args).toBe('api user --jq .login')
    expect(seen.path.split(';')).toEqual([join(dir, 'real').split('\\').join('/')])
  })
  it('replaces the batch shims it wrote and refuses a file it did not', async () => {
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), ['old-cli'])
    await writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), [])
    const bin = workerBin(dir)
    expect(readdirSync(bin).sort()).toEqual(['gh.cmd', 'lark-cli.cmd'])
    // The marker on a later line belongs to no shim dsh-superagent wrote, so a start must not overwrite the file.
    writeFileSync(join(bin, 'notes.cmd'), '@echo off\r\nnotes\r\n:: # Written by dsh-superagent on every start; edits are lost.\r\n')
    await expect(writeEnvironment(testDeployment({ stateDir: dir, feishu: undefined }), [])).rejects.toThrow(`${join(bin, 'notes.cmd')} was not written by dsh-superagent`)
    expect(readFileSync(join(bin, 'notes.cmd'), 'utf8')).toContain('notes')
  })
})
