/**
 * The command line to start a CLI with. Node cannot start a `.cmd` or `.bat` file directly on Windows — spawn throws
 * `EINVAL` — and an operator who installs a CLI through npm gets exactly such a file, so those go through `cmd.exe`,
 * which is what a person typing the same name in a shell gets as well.
 */

/** What to hand to `spawn`: a program, and the arguments that follow it. */
export interface Launched {
  readonly command: string
  readonly args: readonly string[]
}

/** Characters a batch-file command line would read as syntax rather than as part of a value. */
const SYNTAX = /[\s"&|<>^()%!]/

/** The launcher Windows runs batch files with, as an absolute path because a worker's PATH need not hold System32. */
const shellFor = (): string => `${process.env.SystemRoot ?? 'C:\\Windows'}\\System32\\cmd.exe`

/**
 * The program and arguments to spawn: on Windows a batch file goes through `cmd.exe /d /s /c`, which is handed the whole
 * line as one argument and strips its own outer pair of quotes; everywhere else, and for an executable, nothing changes.
 *
 * A batch file cannot be handed a value with a space in it: the line is one argument, and the quoting that would keep the
 * value together is escaped away before `cmd.exe` sees it. That failure is reported where it happens, naming the fix.
 */
export function launchCommand(program: string, args: readonly string[], platform: string = process.platform): Launched {
  if (platform !== 'win32' || !/\.(?:cmd|bat)$/i.test(program)) return { command: program, args: [...args] }
  const broken = args.find(arg => SYNTAX.test(arg))
  if (broken !== undefined) throw new Error(`${program} is a batch file, and Windows cannot pass it ${JSON.stringify(broken)} unchanged; point the setting at that CLI's .exe instead.`)
  return { command: shellFor(), args: ['/d', '/s', '/c', [program, ...args].join(' ')] }
}

/**
 * A shell script as the program and arguments that run it. Windows has no `sh`, so its command is handed to `cmd.exe`
 * with its lines joined by `&&`: each line runs only if the one before it succeeded, which is what `sh -c` would do.
 */
export function shellLine(command: string, platform: string = process.platform): Launched {
  if (platform !== 'win32') return { command: 'sh', args: ['-c', command] }
  const lines = command.split(/\r?\n/).map(line => line.trim()).filter(line => line !== '')
  return { command: shellFor(), args: ['/d', '/s', '/c', lines.join(' && ')] }
}

/**
 * A Sandboxie box to start commands in: the launcher and the box it names. A box confines what the command writes, which
 * is what an operator wants of the commands a worker's work runs, and it costs one more process in the chain.
 */
export interface Sandbox {
  readonly launcher: string
  readonly box: string
}

/** Where Sandboxie-Plus installs its launcher; an install elsewhere is named by DSH_SUPERAGENT_SANDBOX_EXE. */
const SANDBOX_LAUNCHER = 'C:\\Program Files\\Sandboxie-Plus\\Start.exe'

/**
 * The box to start commands in, when the operator asked for one: `DSH_SUPERAGENT_SANDBOX=1` turns it on and
 * `DSH_SUPERAGENT_SANDBOX_BOX` names the box. Nothing is boxed unless a person configured it, so a machine without
 * Sandboxie works exactly as it did before.
 */
export function sandboxFrom(environment: Record<string, string | undefined> = process.env, platform: string = process.platform): Sandbox | undefined {
  if (platform !== 'win32' || environment.DSH_SUPERAGENT_SANDBOX !== '1') return undefined
  return {
    launcher: environment.DSH_SUPERAGENT_SANDBOX_EXE ?? SANDBOX_LAUNCHER,
    box: environment.DSH_SUPERAGENT_SANDBOX_BOX ?? 'superagent_worker',
  }
}

/**
 * The same command, started inside the box: Sandboxie's launcher takes the box name and then the program with its
 * arguments, and `/silent` keeps a box that cannot start from stopping for a dialog nobody is there to answer.
 */
export function boxed(run: Launched, sandbox: Sandbox | undefined): Launched {
  if (sandbox === undefined) return run
  return { command: sandbox.launcher, args: [`/box:${sandbox.box}`, '/silent', run.command, ...run.args] }
}
