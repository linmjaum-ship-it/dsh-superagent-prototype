/**
 * Screens untrusted text (issue bodies, comments, mail) for prompt-injection structure before an admission payload carries
 * it. Zero dependencies by design: the first version is structural defense plus rules, so a flagged thread still reaches
 * the main Session as data with a score, and the admission decision stays a bounded structured object.
 */

/** One matched rule: what it saw and how much it adds to the score. */
export interface ScanSignal {
  rule: string
  weight: number
  excerpt: string
}

/** The verdict for one scanned text. `flagged` is the only field an operator acts on; `score` is what the log keeps. */
export interface ScanResult {
  score: number
  flagged: boolean
  signals: ScanSignal[]
}

/** A rule runs on the whole text and returns the matched excerpt, or undefined when it does not fire. */
interface Rule {
  readonly name: string
  readonly weight: number
  readonly find: (text: string) => string | undefined
}

const ZERO_WIDTH = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g

const excerpt = (text: string, match: RegExpMatchArray | RegExpExecArray): string => {
  const at = match.index ?? 0
  return text.slice(Math.max(0, at - 20), Math.min(text.length, at + 80)).replace(/\s+/g, ' ')
}

const first = (text: string, pattern: RegExp): string | undefined => {
  const match = pattern.exec(text)
  return match ? excerpt(text, match) : undefined
}

const RULES: readonly Rule[] = [
  { name: 'override_instructions', weight: 0.45, find: text => first(text, /(忽略|无视|忘记)(以上|之前|前面|上面)?[^。\n]{0,6}(规则|指令|要求|限制)/)
    ?? first(text, /ignore\s+(all\s+|any\s+)?(the\s+)?(previous|above|prior|earlier)\s+(instructions|rules|prompts)/i)
    ?? first(text, /disregard\s+(the\s+)?(instructions|rules|guardrails)/i) },
  { name: 'merge_without_review', weight: 0.45, find: text => first(text, /(直接|立即|马上)[^。\n]{0,4}(合并|合入)[^。\n]{0,8}(main|master|主干|主分支)/i)
    ?? first(text, /merge\s+[^\n]{0,30}(main|master)[^\n]{0,20}(directly|immediately|now|without\s+(review|checks))/i) },
  { name: 'role_impersonation', weight: 0.35, find: text => first(text, /你现在是|从现在起你是|act\s+as\s+(an?\s+)?(admin|administrator|system|developer\s+mode)/i)
    ?? first(text, /<\s*\|?\s*system\s*\|?\s*>|system\s+prompt\s*[:=]/i) },
  { name: 'hidden_payload', weight: 0.35, find: text => {
    const count = text.match(ZERO_WIDTH)?.length ?? 0
    if (count >= 3) return `${count} zero-width characters`
    return first(text, /<!--[\s\S]{0,300}?(ignore|忽略|merge|合并|system)[\s\S]{0,300}?-->/i)
  } },
  { name: 'encoded_payload', weight: 0.3, find: text => first(text, /[A-Za-z0-9+/]{80,}={0,2}/) },
  { name: 'secret_exfiltration', weight: 0.5, find: text => first(text, /(curl|wget|invoke-webrequest)\s[^\n]{0,80}(token|api[_-]?key|secret|password)/i)
    ?? first(text, /(print|echo|cat)\s[^\n]{0,40}(\$\{?)?(GITHUB_TOKEN|GH_TOKEN|OPENAI_API_KEY|AWS_SECRET)/i) },
  { name: 'tool_imitation', weight: 0.3, find: text => first(text, /<\s*tool[_-]?call|<\s*\/?\s*function_call|\[tool\]|assistant\s+to=/i) },
]

/** The score at which a thread is called out in the payload the main Session reads. */
export const FLAG_THRESHOLD = 0.5

/** Scans one text; every rule fires once, and the score is the capped sum of its weights. */
export function scanUntrusted(text: string): ScanResult {
  const signals: ScanSignal[] = []
  for (const rule of RULES) {
    const hit = rule.find(text)
    if (hit !== undefined) signals.push({ rule: rule.name, weight: rule.weight, excerpt: hit.slice(0, 140) })
  }
  const score = Math.min(1, Math.round(signals.reduce((total, signal) => total + signal.weight, 0) * 100) / 100)
  return { score, flagged: score >= FLAG_THRESHOLD, signals }
}

/** Scans a bounded window of untrusted texts together, as one thread's evidence rather than one message at a time. */
export function scanThread(texts: readonly string[], limit = 20_000): ScanResult {
  let budget = limit
  const parts: string[] = []
  for (const text of texts) {
    if (budget <= 0) break
    parts.push(text.slice(0, budget))
    budget -= text.length
  }
  return scanUntrusted(parts.join('\n\n'))
}

/** The payload field an assessment carries when a thread tripped at least one rule. */
export function scanView(result: ScanResult) {
  return { score: result.score, flagged: result.flagged,
    signals: result.signals.map(signal => ({ rule: signal.rule, weight: signal.weight, excerpt: signal.excerpt })) }
}
