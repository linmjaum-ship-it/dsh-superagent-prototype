/**
 * The command gate: the names a worker's shell must refuse, normalized so a blocked command cannot slip past the shim
 * as `RM`, as `rm.exe`, or as a path such as `C:\Windows\System32\rm.exe`.
 *
 * The shims live on the worker's PATH, not in the kernel, so the gate covers what a shell resolves: a bare name, a
 * name with an executable suffix, and a path whose base name matches. Programs that never consult PATH (an editor's
 * plugin, a native binary reached by another name) remain outside this guardrail, as the module's README states.
 */
/** Suffixes a Windows shell tries when resolving a bare name, so a shim is written for each one. */
const SUFFIXES = ['.exe', '.cmd', '.bat', '.com', '.ps1'] as const

/** Strips an executable suffix from a file name, so `rm.exe` and `rm` name the same command. */
function withoutSuffix(name: string): string {
  const lower = name.toLowerCase()
  const suffix = SUFFIXES.find(candidate => lower.endsWith(candidate))
  return suffix === undefined ? name : name.slice(0, -suffix.length)
}

/**
 * The command a program name resolves to: the file name without directories, without an executable suffix, lowercased.
 * @param program - the program as a shell would look it up, such as `rm.exe` or `C:\Tools\RM.EXE`.
 */
export function commandName(program: string): string {
  // Split on both separators: a Windows path reaches a POSIX `basename` unchanged, which would keep the directory.
  const file = program.trim().split(/[\\/]/).pop() ?? ''
  return withoutSuffix(file).toLowerCase()
}

/**
 * The blocked command `program` resolves to, if any: absolute paths and suffix variants match the same entry.
 * @param program - the program a worker's shell would run.
 * @param blocked - the configured command names this installation refuses.
 */
export function blockedCommand(program: string, blocked: readonly string[]): string | undefined {
  const name = commandName(program)
  return blocked.find(entry => commandName(entry) === name)
}

/**
 * The shim files to write for each blocked command: the bare name a POSIX shell resolves plus the suffixes a Windows
 * shell tries first. The caller filters out the commands workers need before calling this.
 * @param blocked - the configured command names this installation refuses.
 */
export function shimNames(blocked: readonly string[]): string[] {
  const names = new Set<string>()
  for (const entry of blocked) {
    const name = commandName(entry)
    if (name === '') continue
    names.add(name)
    for (const suffix of SUFFIXES) names.add(name + suffix)
  }
  return [...names]
}

/**
 * A shell command line the gate refuses before it runs. The rules read the whole line, since a pipe or a substitution
 * hides the second program from `blockedCommand`, which only sees the program it is handed.
 */
export interface ShellRule {
  /** Stable id, carried in the refusal a person reads and in the alert. */
  readonly id: string
  readonly pattern: RegExp
  /** Why the line is refused, completing "The command gate refused this command". */
  readonly why: string
  /** A person may approve this rule on a card; the other rules are refused outright. */
  readonly approvable?: boolean
}

/** The shell patterns a worker's Session refuses, whatever its ticket asked for. */
export const SHELL_RULES: readonly ShellRule[] = [
  { id: 'pipe_to_shell', why: 'a download piped into an interpreter runs whatever the network returns',
    pattern: /\b(?:curl|wget|iwr|invoke-webrequest)\b[^|;&\n]*\|\s*(?:sudo\s+)?(?:sh|bash|zsh|dash|pwsh|powershell)\b/i },
  { id: 'shell_from_network', why: 'the interpreter runs a script fetched from the network',
    pattern: /\b(?:sh|bash|zsh|dash)\b[^\n]*?(?:-c\s*["'`]?\s*\$\(|\s<\(\s*)(?:curl|wget)\b/i },
  { id: 'force_push', why: 'a force push rewrites shared history and cannot be undone', approvable: true,
    pattern: /\bgit\s+push\b[^\n]*?(?:--force-with-lease\b|--force\b|-f\b)/i },
  { id: 'repo_delete', why: 'deleting a repository cannot be undone', approvable: true,
    pattern: /\bgh\s+repo\s+delete\b/i },
]

/**
 * The rule a tool call breaks, if any: only a shell call carries a command line to read.
 * @param name - the tool a worker's model called.
 * @param input - that call's arguments, as the model passed them.
 */
export function shellRule(name: string, input: unknown): ShellRule | undefined {
  if (name !== 'bash' && name !== 'pwsh') return undefined
  const command = (input as { command?: unknown } | undefined)?.command
  return typeof command === 'string' ? SHELL_RULES.find(rule => rule.pattern.test(command)) : undefined
}

/**
 * The rules a person may approve instead of the gate refusing them outright: a force push or a repository delete is
 * sometimes exactly what the ticket is for, so those two wait for a card rather than ending the work.
 */
export const APPROVABLE_RULES: readonly string[] = SHELL_RULES.filter(rule => rule.approvable === true).map(rule => rule.id)

/**
 * The refusal a worker's guard returns for a shell call whose rule a person approves on a card: until that approval
 * arrives, the call does not run, and the worker is told a card went out rather than that the work is impossible.
 * @param name - the tool a worker's model called.
 * @param input - that call's arguments, as the model passed them.
 */
/**
 * The refusal for a command a person already answered no to: retrying it only repeats the refusal, so the worker is told
 * to change approach instead of waiting on another card.
 */
export function refusedRefusal(name: string, input: unknown): string | undefined {
  const rule = shellRule(name, input)
  return rule === undefined ? undefined
    : `The command gate refused this command (rule: ${rule.id}): a person already said no. Do not run it again; ask the main Session for a different approach.`
}

export function approvalRefusal(name: string, input: unknown): string | undefined {
  const rule = shellRule(name, input)
  return rule === undefined ? undefined
    : `The command gate asked a person to approve this command (rule: ${rule.id}): ${rule.why}. A card was sent; wait for the approval, then call the same tool again.`
}

/**
 * The refusal a worker's guard returns for a shell call the gate refuses, or `undefined` to let the call run.
 * @param name - the tool a worker's model called.
 * @param input - that call's arguments, as the model passed them.
 */
export function shellRefusal(name: string, input: unknown): string | undefined {
  const rule = shellRule(name, input)
  return rule === undefined ? undefined
    : `The command gate refused this command (rule: ${rule.id}): ${rule.why}. Ask the main Session for a decision instead.`
}
