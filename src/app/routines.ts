/** Cron-scheduled routines: templates the agent runs on its own, admitted as inferred candidates that the accept mode decides. */
import { key, type Trigger } from '../core/index.ts'
import type { Store } from './store.ts'

export interface Routine {
  id: string
  name: string
  /** Five-field cron expression, or one of the `@hourly`, `@daily`, `@weekly`, `@monthly`, `@yearly` nicknames. */
  cron: string
  /** What a fired Trigger asks the agent to do, in the operator's words. */
  prompt: string
  enabled: boolean
  createdAt: string
  /** When it last fired. */
  lastAt?: string
  /** When it fires next; maintained on save and after every fire. */
  nextAt: string
}

/** What a routine needs from the runtime: the Engine's intake, and where to note a fire. */
export interface RoutineHost {
  /** Hands a fresh Trigger to the Engine and returns how Intake took it. */
  receive(trigger: Trigger): string
  log?(line: string): void
}

const NICKNAMES: Readonly<Record<string, string>> = {
  '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *',
}

interface Schedule {
  minutes: Set<number>
  hours: Set<number>
  days: Set<number>
  months: Set<number>
  weekdays: Set<number>
  /** The day-of-month field is `*`: only the weekday decides the day. */
  anyDay: boolean
  /** The weekday field is `*`: only the day of the month decides the day. */
  anyWeekday: boolean
}

const BOUNDS: Readonly<Record<string, readonly [number, number]>> = {
  minute: [0, 59], hour: [0, 23], day: [1, 31], month: [1, 12], weekday: [0, 7],
}

/** Expand one cron field into the values it names, so a `*`, a list, a range, and a step all read the same way. */
function field(text: string, name: string): Set<number> {
  const [min, max] = BOUNDS[name]!
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const [span = '', stepText = '1'] = part.trim().split('/')
    if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new Error(`routine cron: the ${name} step of ${part} is not a positive integer`)
    const step = Number(stepText)
    let from = min
    let to = max
    if (span !== '*') {
      const [first = '', second] = span.split('-')
      if (!/^\d+$/.test(first) || (second !== undefined && !/^\d+$/.test(second))) throw new Error(`routine cron: the ${name} value ${part} is not a number, a range, or *`)
      from = Number(first)
      to = second === undefined ? Number(first) : Number(second)
      // A step over a single value repeats it forever, so only `*`, a range, and a lone value are accepted.
      if (second === undefined && step !== 1) throw new Error(`routine cron: the ${name} step of ${part} needs a range or *`)
    }
    for (let value = from; value <= to; value += step) {
      if (value < min || value > max) throw new Error(`routine cron: ${value} is outside the ${name} range ${min}-${max}`)
      values.add(name === 'weekday' && value === 7 ? 0 : value)
    }
  }
  return values
}

/** Parse a five-field cron expression, accepting the common nicknames; throws with what is wrong when it cannot. */
export function parseCron(expression: string): Schedule {
  const text = NICKNAMES[expression.trim()] ?? expression.trim()
  const fields = text.split(/\s+/)
  if (fields.length !== 5) throw new Error(`routine cron: expected five fields, got ${fields.length} in ${expression}`)
  const [minute = '', hour = '', day = '', month = '', weekday = ''] = fields
  return { minutes: field(minute, 'minute'), hours: field(hour, 'hour'), days: field(day, 'day'), months: field(month, 'month'),
    weekdays: field(weekday, 'weekday'), anyDay: day === '*', anyWeekday: weekday === '*' }
}

const SIX_HOURS_MS = 366 * 24 * 60 * 60 * 1000

/** The first minute at or after `from` the expression names; a day field and a weekday field both set match on either. */
export function nextRun(expression: string, from: Date): Date {
  const schedule = parseCron(expression)
  const start = new Date(from.getTime() + 60_000)
  start.setSeconds(0, 0)
  const limit = start.getTime() + SIX_HOURS_MS
  for (let at = start.getTime(); at <= limit; at += 60_000) {
    const date = new Date(at)
    if (!schedule.months.has(date.getMonth() + 1) || !schedule.hours.has(date.getHours()) || !schedule.minutes.has(date.getMinutes())) continue
    const day = schedule.days.has(date.getDate())
    const week = schedule.weekdays.has(date.getDay())
    const named = schedule.anyDay && schedule.anyWeekday ? true : schedule.anyDay ? week : schedule.anyWeekday ? day : day || week
    if (named) return date
  }
  throw new Error(`routine cron: ${expression} never fires within a year`)
}

export interface RoutineInput {
  id?: string
  name: string
  cron: string
  prompt: string
  enabled?: boolean
}

/** Persists routines and fires the ones that came due, turning each into a Trigger the accept mode decides on. */
export class Routines {
  constructor(private readonly store: Store, private readonly host: RoutineHost) {}

  list(): Routine[] { return this.store.routines.list() }

  save(input: RoutineInput): Routine {
    const name = input.name.trim()
    if (!name) throw new Error('A routine needs a name')
    const prompt = input.prompt.trim()
    if (!prompt) throw new Error('A routine needs a prompt')
    const cron = (NICKNAMES[input.cron.trim()] ?? input.cron.trim())
    const at = new Date()
    const existing = input.id === undefined ? undefined : this.store.routines.get(input.id)
    const routine: Routine = { id: existing?.id ?? key('routine', name, cron, at.toISOString()), name, cron, prompt,
      enabled: input.enabled ?? existing?.enabled ?? true, createdAt: existing?.createdAt ?? at.toISOString(),
      ...existing?.lastAt === undefined ? {} : { lastAt: existing.lastAt }, nextAt: nextRun(cron, at).toISOString() }
    this.store.routines.save(routine)
    return routine
  }

  remove(id: string): boolean { return this.store.routines.remove(id) }

  /** Fire every enabled routine whose `nextAt` came due, then move it to its next run; returns the ids that fired. */
  advance(now = new Date()): string[] {
    const fired: string[] = []
    for (const routine of this.store.routines.list()) {
      if (!routine.enabled) continue
      if (Date.parse(routine.nextAt) > now.getTime()) continue
      const at = now.toISOString()
      const trigger: Trigger = { id: key('trigger', 'routine', routine.id, at), source: 'routine', threads: [{ source: 'routine', id: routine.id }],
        actor: { source: 'routine', id: routine.id }, human: false, at, text: routine.prompt, meta: { routine: routine.id } }
      try {
        const result = this.host.receive(trigger)
        this.host.log?.(`routine ${routine.id} fired: ${result}`)
      } catch (error) {
        // A trigger that cannot enter is the routine's problem, not the pass's: keep the schedule and report it.
        this.host.log?.(`routine ${routine.id} could not fire: ${String(error)}`)
      }
      this.store.routines.save({ ...routine, lastAt: at, nextAt: nextRun(routine.cron, now).toISOString() })
      fired.push(routine.id)
    }
    return fired
  }
}
