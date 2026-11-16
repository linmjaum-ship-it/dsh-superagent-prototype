/**
 * The process guard: the operating system kills a blocked command line as soon as a worker starts it.
 * The tool a worker's model calls passes the gate in this package, but a Session's shell tool is not that gate: a
 * worker can ask its shell for anything, and the gate never sees it. This guard is the second wall — a small
 * supervisor on the same process tree that kills a matching command line and leaves the line it killed in
 * `guard.log` — so a path, a suffix or a shell builtin does not get around the rules. It runs when the operator sets
 * `DSH_SUPERAGENT_GUARD=1`; without it the gate alone still refuses the tool calls it can see.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { SHELL_RULES } from './command-gate.ts'
import { packagePath } from '../infra/paths.ts'
import type { Machine } from '../deployment.ts'

/** A regular expression the guard kills on, as the script's plain text rule file carries it: one per line. */
export function guardPatterns(blocked: readonly string[]): string[] {
  const patterns = SHELL_RULES.map(rule => rule.pattern.source)
  for (const entry of blocked) {
    const name = entry.trim()
    if (name !== '') patterns.push(`\\b${literal(name)}\\b`)
  }
  return patterns
}

/** A command name read as a literal: the dots of `rm.exe` match a literal dot, not any character. */
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Where the guard reads its rules from and writes what it killed. */
export interface GuardFiles {
  readonly script: string
  readonly rules: string
  readonly log: string
}

/** The guard's three files: the shipped script, and the rules and log that live beside the rest of the state. */
export function guardFiles(machine: Machine): GuardFiles {
  return { script: packagePath('scripts', 'process-guard.ps1'), rules: join(machine.stateDir, 'guard-rules.txt'),
    log: join(machine.stateDir, 'guard.log') }
}

/** The guard supervisor, one per Runtime: `start` writes the rules and spawns the script, `stop` ends it. */
export class ProcessGuard {
  private child?: ChildProcess
  constructor(
    private readonly files: () => GuardFiles,
    /** Commands this installation blocks, read when the guard starts. */
    private readonly blocked: () => readonly string[],
    /** A guard that cannot start is reported, not fatal: the gate still refuses the calls it sees. */
    private readonly report: (error: unknown) => void = () => {},
  ) {}

  /** Write the rules and start watching the process tree below `rootPid`. */
  start(rootPid: number): void {
    try {
      const files = this.files()
      mkdirSync(dirname(files.rules), { recursive: true, mode: 0o700 })
      writeFileSync(files.rules, `${guardPatterns(this.blocked()).join('\n')}\n`, 'utf8')
      const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', files.script,
        '-RootPid', String(rootPid), '-RulesPath', files.rules, '-LogPath', files.log, '-IntervalMs', '800'],
      { windowsHide: true, stdio: 'ignore' })
      child.on('error', error => this.report(error))
      child.unref()
      this.child = child
    } catch (error) {
      this.report(error)
    }
  }

  /** End the supervisor; a guard that already exited is not an error. */
  async stop(): Promise<void> {
    const child = this.child
    this.child = undefined
    if (child === undefined) return
    await new Promise<void>(resolve => {
      child.once('exit', () => { resolve() })
      try { child.kill() } catch { resolve() }
    })
  }
}
