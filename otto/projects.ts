#!/usr/bin/env bun
/**
 * What is actually in ~/Documents/Projects.
 *
 * Every dev-facing thing Otto does starts by rediscovering the same facts. "Is
 * the site up" needs the deploy URL. "Did CI pass" needs the workflow file and
 * the git remote. "Install it" needs to know that this repo is bun and that one
 * is uv. None of that is written down anywhere, so each feature guesses it
 * again from scratch — and guesses differently, which is worse than guessing
 * badly, because two watchers then disagree about the same repo.
 *
 * This is a nightly scan that writes it down once: one record per repo, with
 * the remote, the package manager and its lockfile, the CI workflows, the
 * deploy URLs and domains, the last tag and the last commit. Everything else
 * reads projects.json instead of running its own `git remote -v`.
 *
 * Two rules keep it honest. Nothing is inferred that is not in a file — a repo
 * with no vercel.json gets no Vercel URL, not a plausible one. And a repo that
 * fails to scan is recorded as failing, never as empty: "no CI workflows" and
 * "could not read the repo" are different facts and only one of them means
 * "stop looking".
 *
 * The parsers are pure and take file contents; the I/O layer at the bottom
 * feeds them. That split is what makes the fixtures in the test file possible.
 *
 * CLI: `bun otto/projects.ts [--json]`
 */

import { readFileSync, writeFileSync, renameSync, readdirSync, statSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join, basename } from 'path'

export type GitRemote = {
  /** "github.com", "gitlab.com". */
  host: string
  owner: string
  repo: string
  /** Browsable URL, normalized out of whatever form the remote was written in. */
  web: string
}

export type ProjectRecord = {
  name: string
  path: string
  remote?: GitRemote
  branch?: string
  packageManager?: string
  /** Absolute paths, in case there is more than one workspace root. */
  lockfiles: string[]
  /** Repo-relative paths under .github/workflows. */
  workflows: string[]
  deployUrls: string[]
  domains: string[]
  lastTag?: string
  lastCommit?: { sha: string; ts: string; subject: string }
  /** Set when the scan itself failed. An empty record and a broken one are not
   * the same thing and must not read the same. */
  error?: string
  scannedAt: string
}

// ---------------------------------------------------------------------------
// Pure parsing
// ---------------------------------------------------------------------------

/**
 * Normalize any remote spelling into one shape.
 *
 * `git@github.com:owner/repo.git`, `https://github.com/owner/repo.git` and
 * `ssh://git@github.com/owner/repo` are the same repository, and code that
 * compares them as strings is code that thinks the user has three.
 */
export function parseGitRemote(url: string): GitRemote | undefined {
  const clean = url.trim().replace(/\.git$/, '')
  if (!clean) return undefined
  let m = /^(?:ssh:\/\/)?(?:[\w.-]+@)?([\w.-]+)[:/]([^/]+)\/(.+)$/.exec(clean.replace(/^https?:\/\//, ''))
  if (!m) return undefined
  const [, host, owner, repo] = m
  if (!host.includes('.')) return undefined
  return { host, owner, repo, web: `https://${host}/${owner}/${repo}` }
}

/** Lockfile -> manager. Ordered: the first match wins when a repo has several,
 * which happens when someone ran npm once inside a bun project. */
const LOCKFILES: [string, string][] = [
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['package-lock.json', 'npm'],
  ['uv.lock', 'uv'],
  ['poetry.lock', 'poetry'],
  ['Pipfile.lock', 'pipenv'],
  ['requirements.txt', 'pip'],
  ['Cargo.lock', 'cargo'],
  ['go.sum', 'go'],
  ['Gemfile.lock', 'bundler'],
]

export function detectPackageManager(files: string[]): { manager?: string; lockfiles: string[] } {
  const present = new Set(files)
  const lockfiles = LOCKFILES.filter(([f]) => present.has(f)).map(([f]) => f)
  const manager = LOCKFILES.find(([f]) => present.has(f))?.[1]
  return { ...(manager ? { manager } : {}), lockfiles }
}

const URL_RE = /https?:\/\/[^\s"'`)\]}>,]+/g

/** Hosts whose URLs are never a deploy target — they are the source, the docs,
 * or a badge. Left out of the domain list too. */
const NOT_DEPLOYS = /(^|\.)(github\.com|gitlab\.com|bitbucket\.org|npmjs\.com|shields\.io|badge\.fury\.io|localhost)$/i

function hostOf(url: string): string | undefined {
  try { return new URL(url).hostname } catch { return undefined }
}

/**
 * Deploy URLs, from config files only.
 *
 * Every source here is a file whose entire purpose is to say where this thing
 * is served from. README prose is deliberately excluded: it is where stale URLs
 * go to be believed for years.
 */
export function deployUrlsFrom(sources: { file: string; text: string }[]): string[] {
  const out = new Set<string>()
  const add = (u?: string) => {
    if (!u) return
    const url = u.startsWith('http') ? u : `https://${u}`
    const host = hostOf(url)
    if (!host || NOT_DEPLOYS.test(host)) return
    out.add(url.replace(/\/+$/, ''))
  }

  for (const { file, text } of sources) {
    const base = basename(file)
    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(text) as { homepage?: string }
        add(pkg.homepage)
      } catch {}
      continue
    }
    if (base === 'vercel.json') {
      try {
        const cfg = JSON.parse(text) as { alias?: string | string[] }
        for (const a of [cfg.alias ?? []].flat()) add(a)
      } catch {}
      // Vercel configs also carry redirect destinations; only aliases are the app.
      continue
    }
    if (base === 'CNAME') {
      // GitHub Pages: the file is one bare hostname and nothing else.
      for (const line of text.split('\n')) add(line.trim())
      continue
    }
    if (base === 'netlify.toml' || base === 'wrangler.toml' || base === 'fly.toml' || base === 'app.yaml') {
      for (const u of text.match(URL_RE) ?? []) add(u)
      // wrangler routes and netlify custom domains are written bare.
      for (const m of text.matchAll(/^\s*(?:pattern|route|custom_domain|domain)\s*=\s*["']([^"'/*]+)/gm)) add(m[1])
      continue
    }
  }
  return [...out]
}

export function domainsFrom(urls: string[]): string[] {
  const out = new Set<string>()
  for (const u of urls) {
    const h = hostOf(u)
    if (h) out.add(h)
  }
  return [...out]
}

/** `git log -1 --format=%H%x00%cI%x00%s`. NUL-separated so a subject with any
 * punctuation in it cannot split the record. */
export function parseGitLog(out: string): { sha: string; ts: string; subject: string } | undefined {
  const [sha, ts, ...rest] = out.trim().split('\0')
  if (!sha || !ts) return undefined
  return { sha: sha.slice(0, 12), ts, subject: rest.join('\0').trim() }
}

/** Newest tag from `git tag --sort=-creatordate`. */
export function parseTags(out: string): string | undefined {
  return out.split('\n').map(l => l.trim()).filter(Boolean)[0]
}

export function formatProject(p: ProjectRecord): string {
  if (p.error) return `${p.name}: scan failed (${p.error})`
  const bits: string[] = []
  if (p.remote) bits.push(p.remote.web)
  if (p.packageManager) bits.push(p.packageManager)
  if (p.deployUrls.length) bits.push(`deploys: ${p.deployUrls.join(', ')}`)
  if (p.workflows.length) bits.push(`ci: ${p.workflows.length}`)
  if (p.lastTag) bits.push(`tag ${p.lastTag}`)
  if (p.lastCommit) bits.push(`last commit ${p.lastCommit.ts.slice(0, 10)}`)
  return `${p.name}: ${bits.join(' · ') || 'nothing detected'}`
}

/**
 * The durable memory this becomes.
 *
 * Written as a `project`-scoped memory so that any Claude Code session opened
 * in that repo can recall it, not just Otto. The description is the one line a
 * search will match on, so it names the repo and what it deploys to.
 */
export function renderProjectMemory(p: ProjectRecord): {
  name: string
  description: string
  type: 'project'
  body: string
  scope: string
} {
  const lines = [
    `- path: ${p.path}`,
    ...(p.remote ? [`- remote: ${p.remote.web} (${p.remote.host})`] : []),
    ...(p.branch ? [`- default branch checked out: ${p.branch}`] : []),
    ...(p.packageManager ? [`- package manager: ${p.packageManager}${p.lockfiles.length ? ` (${p.lockfiles.join(', ')})` : ''}`] : []),
    ...(p.workflows.length ? [`- CI: ${p.workflows.join(', ')}`] : []),
    ...(p.deployUrls.length ? [`- deploys to: ${p.deployUrls.join(', ')}`] : []),
    ...(p.domains.length ? [`- domains: ${p.domains.join(', ')}`] : []),
    ...(p.lastTag ? [`- last tag: ${p.lastTag}`] : []),
    ...(p.lastCommit ? [`- last commit: ${p.lastCommit.sha} ${p.lastCommit.ts.slice(0, 10)} — ${p.lastCommit.subject}`] : []),
    '',
    `Scanned ${p.scannedAt.slice(0, 10)} by the nightly project scan. Facts here come from files in the repo; anything absent was not written down, not inferred.`,
  ]
  const summary = [
    p.packageManager,
    p.remote ? `${p.remote.owner}/${p.remote.repo}` : undefined,
    p.deployUrls[0],
  ].filter(Boolean).join(', ')
  return {
    name: `project-${p.name}`,
    description: `${p.name} repo facts — ${summary || 'local only'}`,
    type: 'project',
    body: lines.join('\n'),
    scope: p.path,
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function loadProjects(file: string): ProjectRecord[] {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(parsed) ? (parsed as ProjectRecord[]) : []
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      try { renameSync(file, `${file}.corrupt-${Date.now()}`) } catch {}
      process.stderr.write('otto channel: projects.json corrupt, moved aside.\n')
    }
    return []
  }
}

export function saveProjects(file: string, records: ProjectRecord[]): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, JSON.stringify(records, null, 2) + '\n', { mode: 0o600 })
  renameSync(tmp, file)
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

const GIT_TIMEOUT_MS = 5_000

async function git(args: string[], cwd: string): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => { try { proc.kill() } catch {} }, GIT_TIMEOUT_MS)
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    return code === 0 ? out : undefined
  } catch {
    return undefined
  }
}

function read(path: string): string | undefined {
  try { return readFileSync(path, 'utf8') } catch { return undefined }
}

/** Config files worth opening. Anything not here is not looked at. */
const CONFIG_FILES = ['package.json', 'vercel.json', 'netlify.toml', 'wrangler.toml', 'fly.toml', 'app.yaml', 'CNAME']

export async function scanProject(dir: string, now = new Date()): Promise<ProjectRecord> {
  const base: ProjectRecord = {
    name: basename(dir),
    path: dir,
    lockfiles: [],
    workflows: [],
    deployUrls: [],
    domains: [],
    scannedAt: now.toISOString(),
  }
  let names: string[]
  try { names = readdirSync(dir) } catch (err) {
    return { ...base, error: String((err as Error).message ?? err) }
  }

  const { manager, lockfiles } = detectPackageManager(names)

  let workflows: string[] = []
  const wfDir = join(dir, '.github', 'workflows')
  try {
    workflows = readdirSync(wfDir).filter(f => /\.ya?ml$/.test(f)).map(f => `.github/workflows/${f}`)
  } catch {}

  const sources = CONFIG_FILES
    .filter(f => names.includes(f))
    .map(f => ({ file: f, text: read(join(dir, f)) ?? '' }))
  // GitHub Pages puts CNAME in the served directory, not always the root.
  for (const sub of ['public', 'docs', 'dist']) {
    const p = join(dir, sub, 'CNAME')
    if (existsSync(p)) sources.push({ file: 'CNAME', text: read(p) ?? '' })
  }
  const deployUrls = deployUrlsFrom(sources)

  const isRepo = existsSync(join(dir, '.git'))
  const [remoteOut, branchOut, logOut, tagOut] = isRepo
    ? await Promise.all([
        git(['remote', 'get-url', 'origin'], dir),
        git(['rev-parse', '--abbrev-ref', 'HEAD'], dir),
        git(['log', '-1', '--format=%H%x00%cI%x00%s'], dir),
        git(['tag', '--sort=-creatordate'], dir),
      ])
    : [undefined, undefined, undefined, undefined]

  const remote = remoteOut ? parseGitRemote(remoteOut) : undefined
  const lastCommit = logOut ? parseGitLog(logOut) : undefined
  const lastTag = tagOut ? parseTags(tagOut) : undefined

  return {
    ...base,
    ...(remote ? { remote } : {}),
    ...(branchOut?.trim() ? { branch: branchOut.trim() } : {}),
    ...(manager ? { packageManager: manager } : {}),
    lockfiles: lockfiles.map(f => join(dir, f)),
    workflows,
    deployUrls,
    domains: domainsFrom(deployUrls),
    ...(lastTag ? { lastTag } : {}),
    ...(lastCommit ? { lastCommit } : {}),
  }
}

/** Every immediate subdirectory that is a git repo. Depth one on purpose — the
 * Projects folder is flat by house rule, and recursing finds node_modules. */
export async function scanProjects(root: string, now = new Date()): Promise<ProjectRecord[]> {
  let entries: string[]
  try { entries = readdirSync(root) } catch { return [] }
  const dirs: string[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const dir = join(root, name)
    try {
      if (!statSync(dir).isDirectory()) continue
      if (!existsSync(join(dir, '.git'))) continue
      dirs.push(dir)
    } catch {}
  }
  const records: ProjectRecord[] = []
  // Serial: this runs at 4am with nothing waiting on it, and 30 concurrent git
  // processes on a machine that might be asleep buys nothing.
  for (const dir of dirs) records.push(await scanProject(dir, now))
  return records
}

export const PROJECTS_FILE = join(
  process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'),
  'projects.json',
)

if (import.meta.main) {
  const root = process.env.OTTO_PROJECTS_DIR ?? join(homedir(), 'Documents', 'Projects')
  const records = await scanProjects(root)
  saveProjects(PROJECTS_FILE, records)
  console.log(
    process.argv.includes('--json')
      ? JSON.stringify(records, null, 2)
      : records.map(formatProject).join('\n'),
  )
}
