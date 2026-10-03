/**
 * The docs say Otto has a `foo_bar` tool, a `baz.json` state file and a
 * `/otto:qux` command. Then someone renames one and nothing fails: the model
 * reads CLAUDE.md at the start of every session and confidently reaches for a
 * thing that is gone. Prose cannot be type-checked, but the nouns in it can be
 * looked up.
 *
 * This is that lookup. It reads the standing docs (CLAUDE.md, AGENTS.md,
 * README.md, every skill, and the plugin instructions block in server.ts) and
 * fails when they name something the code no longer has:
 *
 *   command   `/otto:name` with no skills/name/SKILL.md
 *   tool      a `snake_case` token that appears nowhere in the code
 *   state     a `something.json` or `dir/` in the state list nothing refers to
 *   path      a file path or markdown link that does not resolve
 *   env       an `OTTO_*`-style variable no code reads
 *
 * It only ever checks that a name still EXISTS, never that the prose about it
 * is right, and it errs toward silence: machine-local paths (`~/...`), code
 * fences, and http links are skipped, and IGNORE lists the few deliberate
 * exceptions with a reason each. Run it as `bun otto/docdrift.ts`; the test in
 * tests/docdrift.test.ts runs it against the real tree, so `bun test` fails the
 * moment a doc goes stale.
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { basename, dirname, join, relative } from 'path'

export type Finding = {
  doc: string
  line: number
  kind: 'command' | 'tool' | 'state' | 'path' | 'env'
  token: string
  message: string
}

/** Documented names that are deliberately not in the code, each with the reason. */
export const IGNORE: Record<string, string> = {
  chat_id: 'a channel meta key set by the harness, not by this repo',
  reply_to_text: 'a channel meta key set by the harness, not by this repo',
  reply_to_from: 'a channel meta key set by the harness, not by this repo',
}

/** Hard ceiling the plugin instructions block must stay under. */
export const INSTRUCTIONS_MAX = 2048

// `state` is ~/.otto/state when the repo is cloned to ~/.otto: user data, not docs.
const SKIP_DIRS = new Set(['node_modules', '.git', 'logs', 'runtime', 'state', '.venv', '__pycache__'])
const CODE_EXT = /\.(ts|py|sh|zsh|js|plist|json)$/

function walk(root: string, dir = root, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const abs = join(dir, name)
    const st = statSync(abs)
    if (st.isDirectory()) walk(root, abs, out)
    else out.push(relative(root, abs))
  }
  return out
}

/** Every docs surface, as [label, text] pairs. */
export function docSources(root: string, files: string[]): { doc: string; text: string }[] {
  const docs: { doc: string; text: string }[] = []
  // The template is what every install's CLAUDE.md is written from.
  for (const f of ['CLAUDE.md', 'AGENTS.md', 'README.md', 'templates/CLAUDE.md.template']) {
    if (existsSync(join(root, f))) docs.push({ doc: f, text: readFileSync(join(root, f), 'utf8') })
  }
  for (const f of files.filter(f => /^otto\/skills\/[^/]+\/SKILL\.md$/.test(f))) {
    docs.push({ doc: f, text: readFileSync(join(root, f), 'utf8') })
  }
  const inst = instructionsText(root)
  if (inst) docs.push({ doc: 'otto/server.ts (instructions)', text: inst })
  return docs
}

/** The plugin instructions block, exactly as the server joins it. */
export function instructionsText(root: string): string | null {
  const file = join(root, 'otto', 'server.ts')
  if (!existsSync(file)) return null
  const src = readFileSync(file, 'utf8')
  const start = src.indexOf('instructions: [')
  const end = src.indexOf("].join('\\n')", start)
  if (start < 0 || end < 0) return null
  const lines: string[] = []
  for (const l of src.slice(start + 'instructions: ['.length, end).split('\n')) {
    const m = /^\s*'(.*)',?\s*$/.exec(l)
    if (m) lines.push(m[1].replace(/\\'/g, "'").replace(/\\\\/g, '\\'))
  }
  return lines.join('\n')
}

function stripInstructions(src: string): string {
  const start = src.indexOf('instructions: [')
  const end = src.indexOf("].join('\\n')", start)
  return start < 0 || end < 0 ? src : src.slice(0, start) + src.slice(end)
}

/** Concatenated non-test code and scripts: what "exists in the code" means. */
function corpus(root: string, files: string[]): string {
  return files
    .filter(f => (CODE_EXT.test(f) || f.startsWith('scripts/hooks/')) && !f.includes('/tests/') && !/(^|\/)bun\.lock/.test(f))
    .map(f => {
      try {
        const src = readFileSync(join(root, f), 'utf8')
        // The instructions block is a doc, not evidence: a name that appears only
        // there would vouch for itself.
        return f === 'otto/server.ts' ? stripInstructions(src) : src
      } catch { return '' }
    })
    .join('\n')
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function checkDocs(root: string): Finding[] {
  const files = walk(root)
  const fileSet = new Set(files)
  const code = corpus(root, files)
  const has = (word: string) => new RegExp(`(^|[^A-Za-z0-9_])${escapeRe(word)}([^A-Za-z0-9_]|$)`).test(code)
  const skills = new Set(files.map(f => /^otto\/skills\/([^/]+)\/SKILL\.md$/.exec(f)?.[1]).filter(Boolean) as string[])
  const findings: Finding[] = []

  const resolves = (raw: string, docDir: string): boolean => {
    let p = raw.replace(/[#?].*$/, '').replace(/^\.\//, '')
    if (!p) return true
    const candidates = [join(docDir, p), p, join('otto', p)]
    if (candidates.some(c => fileSet.has(c) || (existsSync(join(root, c)) && statSync(join(root, c)).isDirectory()))) return true
    // A bare file name is a mention, not a location: it may live anywhere.
    return !p.includes('/') && files.some(f => basename(f) === p)
  }

  for (const { doc, text } of docSources(root, files)) {
    const docDir = dirname(doc.replace(/ \(.*\)$/, ''))
    let inFence = false
    text.split('\n').forEach((line, i) => {
      if (/^\s*```/.test(line)) { inFence = !inFence; return }
      if (inFence) return
      const at = (kind: Finding['kind'], token: string, message: string) =>
        findings.push({ doc, line: i + 1, kind, token, message })

      // Markdown links to files.
      for (const m of line.matchAll(/\]\(([^)\s]+)\)/g)) {
        const target = m[1]
        if (/^(https?:|mailto:|#)/.test(target)) continue
        if (!resolves(target, docDir)) at('path', target, `link target ${target} does not exist`)
      }

      for (const m of line.matchAll(/`([^`\n]+)`/g)) {
        const tok = m[1].trim()
        if (IGNORE[tok]) continue

        const cmd = /^\/otto:([a-z][a-z0-9-]*)/.exec(tok)
        if (cmd) {
          if (!skills.has(cmd[1])) at('command', `/otto:${cmd[1]}`, `no skills/${cmd[1]}/SKILL.md`)
          continue
        }
        // Machine-local paths: only the otto state dir is ours to vouch for.
        const state = /^~\/\.otto\/state\/(.+)$/.exec(tok)
        if (tok.startsWith('~') && !state) continue
        const rel = state ? state[1] : tok
        if (/\s/.test(rel) || /[<>*{}|$]/.test(rel)) continue

        if (/^[A-Za-z0-9._-]+\.json$/.test(rel)) {
          if (!fileSet.has(rel) && !files.some(f => basename(f) === rel) && !has(rel)) {
            at('state', rel, `nothing in the code refers to ${rel}`)
          }
          continue
        }
        if (/^[a-z][a-z0-9-]*\/$/.test(rel) && !state && !rel.startsWith('~')) {
          const dir = rel.slice(0, -1)
          const inCode = new RegExp(`['"\`/]${escapeRe(dir)}['"\`/]`).test(code)
          if (!files.some(f => f.startsWith(rel)) && !inCode) at('state', rel, `no directory or code refers to ${rel}`)
          continue
        }
        if (/\.(ts|md|sh|py|plist|html)$/.test(rel) && !rel.startsWith('.')) {
          if (!resolves(rel, docDir)) at('path', rel, `${rel} does not exist`)
          continue
        }
        if (/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(tok)) {
          if (!has(tok)) at('env', tok, `no code reads ${tok}`)
          continue
        }
        if (/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(tok)) {
          if (!has(tok)) at('tool', tok, `${tok} appears nowhere in the code`)
        }
      }
    })
  }
  return findings
}

export function instructionsOverBudget(root: string): number | null {
  const t = instructionsText(root)
  return t !== null && t.length > INSTRUCTIONS_MAX ? t.length : null
}

export function formatFindings(fs: Finding[]): string {
  return fs.map(f => `${f.doc}:${f.line}  [${f.kind}] ${f.message}`).join('\n')
}

if (import.meta.main) {
  const root = join(import.meta.dir, '..')
  const findings = checkDocs(root)
  const over = instructionsOverBudget(root)
  if (findings.length) console.error(formatFindings(findings))
  if (over !== null) console.error(`plugin instructions are ${over} chars; the cap is ${INSTRUCTIONS_MAX}`)
  if (!findings.length && over === null) console.log('docs match the code')
  process.exit(findings.length || over !== null ? 1 : 0)
}
