import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { boxed, launchCommand, sandboxFrom, shellLine } from '../src/infra/launch.ts'

const windows = process.platform === 'win32'
const shell = `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`

describe('the command a CLI is started with', () => {
  it('starts an executable as itself, on every platform', () => {
    expect(launchCommand('C:\\tools\\agent-gh.exe', ['api', 'user'], 'win32')).toEqual({
      command: 'C:\\tools\\agent-gh.exe',
      args: ['api', 'user'],
    })
    expect(launchCommand('/usr/bin/gh', ['api', 'user'], 'linux')).toEqual({ command: '/usr/bin/gh', args: ['api', 'user'] })
  })

  it('starts a shell script as itself where the file runs on its own', () => {
    expect(launchCommand('/opt/bin/lark-cli.cmd', ['--version'], 'linux')).toEqual({
      command: '/opt/bin/lark-cli.cmd',
      args: ['--version'],
    })
  })

  it('runs a batch file through the shell that can start it', () => {
    const launched = launchCommand('C:\\Users\\me\\AppData\\npm\\lark-cli.cmd', ['event', 'consume', 'x', '--as', 'bot'], 'win32')
    expect(launched.command).toBe(shell)
    expect(launched.args).toEqual(['/d', '/s', '/c', 'C:\\Users\\me\\AppData\\npm\\lark-cli.cmd event consume x --as bot'])
  })

  it('treats a batch file the same however its extension is written', () => {
    const launched = launchCommand('C:\\npm\\LARK-CLI.BAT', ['--version'], 'win32')
    expect(launched.command).toBe(shell)
    expect(launched.args).toEqual(['/d', '/s', '/c', 'C:\\npm\\LARK-CLI.BAT --version'])
  })

  it('refuses an argument a batch file cannot carry, and names the fix', () => {
    expect(() => launchCommand('C:\\npm\\gh.cmd', ['api', 'repos/x', '--jq', '{name: .full_name}'], 'win32'))
      .toThrow(/"\{name: \.full_name\}" unchanged; point the setting at that CLI's \.exe instead/)
  })
})

describe('the command a batch file really runs', () => {
  let directory: string | undefined
  afterAll(async () => { if (directory !== undefined) await rm(directory, { recursive: true, force: true }) })

  it.skipIf(!windows)('starts a batch file this installation wrote, and reads what it printed', async () => {
    directory = await mkdtemp(join(tmpdir(), 'launch-'))
    const script = join(directory, 'lark-cli.cmd')
    await writeFile(script, '@echo off\r\necho spawned by the shell\r\n', 'utf8')
    const launched = launchCommand(script, [], 'win32')
    const ran = await new Promise<string>((resolve, reject) => {
      const child = spawn(launched.command, [...launched.args], { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', data => { out += data })
      child.on('error', reject)
      child.on('close', () => resolve(out.trim()))
    })
    expect(ran).toBe('spawned by the shell')
    // The same file through Node's own spawn would never start at all.
    expect(() => spawn(script, [], { stdio: 'ignore' })).toThrow(/EINVAL/)
  })
})

describe('the shell a prepare script is run with', () => {
  it('hands a script to sh elsewhere, unchanged', () => {
    expect(shellLine('git clone a b &&\nrm -rf build', 'linux')).toEqual({ command: 'sh', args: ['-c', 'git clone a b &&\nrm -rf build'] })
  })

  it('joins the lines of a script for cmd.exe on Windows, which has no sh', () => {
    expect(shellLine('git fetch origin main\n\n  git worktree add w main  \n', 'win32')).toEqual({
      command: shell, args: ['/d', '/s', '/c', 'git fetch origin main && git worktree add w main'],
    })
  })
})

describe('the box a command can be started in', () => {
  it('leaves a command alone until an operator asks for a box', () => {
    expect(sandboxFrom({}, 'win32')).toBeUndefined()
    expect(sandboxFrom({ DSH_SUPERAGENT_SANDBOX: '0' }, 'win32')).toBeUndefined()
    // Sandboxie exists only on Windows, so another platform never boxes anything.
    expect(sandboxFrom({ DSH_SUPERAGENT_SANDBOX: '1' }, 'linux')).toBeUndefined()
  })

  it('names the box Sandboxie-Plus ships with, or the one the operator configured', () => {
    expect(sandboxFrom({ DSH_SUPERAGENT_SANDBOX: '1' }, 'win32')).toEqual({
      launcher: 'C:\\Program Files\\Sandboxie-Plus\\Start.exe', box: 'superagent_worker',
    })
    expect(sandboxFrom({ DSH_SUPERAGENT_SANDBOX: '1', DSH_SUPERAGENT_SANDBOX_BOX: 'probe', DSH_SUPERAGENT_SANDBOX_EXE: 'C:\\sb\\Start.exe' }, 'win32'))
      .toEqual({ launcher: 'C:\\sb\\Start.exe', box: 'probe' })
  })

  it('puts the box name and the command after the launcher, in that order', () => {
    const run = boxed({ command: 'C:\\tools\\gh.exe', args: ['api', 'user'] }, { launcher: 'C:\\sb\\Start.exe', box: 'probe' })
    expect(run).toEqual({
      command: 'C:\\sb\\Start.exe',
      args: ['/box:probe', '/silent', 'C:\\tools\\gh.exe', 'api', 'user'],
    })
    expect(boxed({ command: 'gh.exe', args: [] }, undefined)).toEqual({ command: 'gh.exe', args: [] })
  })
})
