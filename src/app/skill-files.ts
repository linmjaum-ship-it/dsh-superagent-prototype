/** Loads packaged built-in skill definitions and prompt templates from disk. */
import { readFileSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { packagePath } from '../infra/paths.ts'
/**
 * Reads a packaged text file with normalized Unix line endings.
 * @throws Naming the file when it is missing or whitespace-only, because `dsh-superagent` cannot load without it.
 */
function packaged(...parts: string[]): { path: string; text: string } {
  // One absolute part is the file itself: `packagePath` prefixes the installed package, which a temp path lacks.
  const path = parts.length === 1 && isAbsolute(parts[0]!) ? parts[0]! : packagePath(...parts)
  let text: string
  try { text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n') }
  catch (error) {
    throw (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Error(`Missing packaged file: ${path}`, { cause: error }) : error
  }
  if (!text.trim()) throw new Error(`Empty packaged file: ${path}`)
  return { path, text }
}
function load(name: string) {
  const { path, text } = packaged('skills', `dsh-superagent-${name}`, 'SKILL.md')
  const match = /^---\nname: ([^\n]+)\ndescription: ([^\n]+)\n---\n\n([\s\S]*)$/.exec(text)
  if (!match) throw new Error(`Invalid packaged skill: ${path}`)
  return { name: match[1]!, description: match[2]!, content: match[3]!, path }
}
export const bundledSkills = { feishu: load('feishu'), github: load('github') }
/**
 * Loads a built-in prompt file (`prompts/<name>.md`). Source `.md` files are written one sentence per line for
 * readable diffs; `promptFile` joins lines within each paragraph with spaces while keeping blank-line paragraph breaks.
 */
export function promptFile(name: string): string {
  // A name that already ends in `.md` is a file, and an absolute one reaches it directly: together they keep the
  // line-ending cases testable outside `prompts/`, which a temp directory on another drive needs.
  const file = name.endsWith('.md') ? name : `${name}.md`
  const paragraphs = packaged(...(isAbsolute(file) ? [file] : ['prompts', file])).text.trim().split(/\n(?:[ \t]*\n)+/)
  return paragraphs.map(paragraph => paragraph.split('\n').map(line => line.trim()).join(' ')).join('\n')
}
