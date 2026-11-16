/** Tests for scripts/dsh-superagent-service.ps1: its plan changes nothing, and its status probe reads the live service. */
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'scripts', 'dsh-superagent-service.ps1')
/** Runs one action and returns its output, whether or not it exits non-zero: `status` reports a stopped service that way. */
const run = (...args: string[]): { output: string; code: number } => {
  try {
    const stdout = execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
      { encoding: 'utf8', timeout: 60_000 })
    return { output: stdout, code: 0 }
  } catch (error) {
    const failure = error as { stdout?: string; status?: number }
    return { output: failure.stdout ?? '', code: failure.status ?? 1 }
  }
}

// The script targets Windows: a scheduled task, WinSW and Get-NetTCPConnection have no counterpart elsewhere.
describe.skipIf(process.platform !== 'win32')('dsh-superagent-service.ps1', () => {
  it('plans a per-user logon task and runs nothing: every planned command lacks the + prefix an executed one gets', () => {
    const { output, code } = run('-Action', 'plan')
    expect(code).toBe(0)
    expect(output).toContain('method=task')
    expect(output).toContain('--profile superagent --no-open')
    expect(output).toContain("New-ScheduledTaskAction -Execute")
    expect(output).toContain('New-ScheduledTaskTrigger -AtLogOn')
    expect(output).toContain("Register-ScheduledTask -TaskName 'DshSuperAgent'")
    expect(output).toContain('A logon trigger belongs to administrators on this machine')
    expect(output.split('\n').filter(line => line.startsWith('+ '))).toEqual([])
  })

  it('plans a WinSW service, and says the install needs an elevated shell', () => {
    const { output, code } = run('-Action', 'plan', '-Method', 'service')
    expect(code).toBe(0)
    expect(output).toContain('method=service')
    expect(output).toContain("& 'winsw.exe' install")
    expect(output).toContain('elevated shell')
    expect(output.split('\n').filter(line => line.startsWith('+ '))).toEqual([])
  })

  it('plans a per-user Run key a standard user can write, and says it cannot restart the profile after a crash', () => {
    const { output, code } = run('-Action', 'plan', '-Method', 'startup')
    expect(code).toBe(0)
    expect(output).toContain('method=startup')
    expect(output).toContain("New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'")
    expect(output).toContain('--profile superagent --no-open')
    expect(output).toContain('cannot restart the profile after a crash')
    expect(output.split('\n').filter(line => line.startsWith('+ '))).toEqual([])
  })

  it('plans a per-user watchdog task a minute apart, since a crash must come back without a logon or an administrator', () => {
    const { output, code } = run('-Action', 'plan', '-Method', 'watchdog')
    expect(code).toBe(0)
    expect(output).toContain('method=watchdog')
    expect(output).toContain('needs no administrator rights')
    expect(output).toContain("schtasks /create /tn 'DshSuperAgent'")
    expect(output).toContain('-Action keepalive -Method startup')
    expect(output).toContain('/sc minute /mo 1 /f')
    expect(output.split('\n').filter(line => line.startsWith('+ '))).toEqual([])
  })

  it('plans a resident loop ten seconds apart, since a crash must come back inside the half minute the check asks for', () => {
    const { output, code } = run('-Action', 'plan', '-Method', 'supervise')
    expect(code).toBe(0)
    expect(output).toContain('method=supervise')
    expect(output).toContain('probes the port every ten seconds')
    expect(output).toContain('leaves the state lock alone while a process still holds the profile')
    expect(output).toContain('-Action supervise -Method startup')
    expect(output).toContain("New-ItemProperty -Path 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'")
    expect(output.split('\n').filter(line => line.startsWith('+ '))).toEqual([])
  })

  it('hands the state directory to the loop it registers, so a restart can clear the lock a crash left', () => {
    const { output, code } = run('-Action', 'plan', '-Method', 'supervise', '-StateDir', 'F:/YAD/superagent-e2e/state-isolated-t520u')
    expect(code).toBe(0)
    expect(output).toContain('-Action supervise -Method startup -StateDir "F:/YAD/superagent-e2e/state-isolated-t520u"')
    expect(output.split('\n').filter(line => line.startsWith('+ '))).toEqual([])
  })

  it('names the box in the value it registers, so the whole instance comes back inside that box', () => {
    const { output, code } = run('-Action', 'plan', '-Method', 'supervise', '-Box', 'superagent_worker')
    expect(code).toBe(0)
    expect(output).toContain('-Action supervise -Method startup -Box "superagent_worker"')
    expect(output.split('\n').filter(line => line.startsWith('+ '))).toEqual([])
  })

  it('reports whether the task is registered and whether the profile answers, in one line', () => {
    const { output } = run('-Action', 'status')
    expect(output.trim()).toMatch(/^target=DshSuperAgent registered=(True|False) running=(True|False) .*port=3082 listening=(True|False) state=(http 200|unreachable)$/)
  })
})
