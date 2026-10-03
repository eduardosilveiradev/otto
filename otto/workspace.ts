#!/usr/bin/env bun
/**
 * What the user is actually doing on this Mac, in one line.
 *
 * Otto's late-night pings used to be generic because it had no idea whether the user
 * was building, reading or asleep. This is the cheapest possible fix: the
 * frontmost app and any repo the user has touched today with uncommitted work.
 *
 * Everything here fails soft and silently. Accessibility permission may be
 * denied, git may be absent, a repo may be mid-rebase — none of that is worth a
 * word to the user, so every probe returns undefined instead of throwing.
 *
 * CLI: `bun otto/workspace.ts [--json]`
 */

import { readdirSync, statSync, existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export type RepoState = { name: string; branch?: string; dirty: number }
export type Workspace = { app?: string; repos: RepoState[] }

const PROBE_TIMEOUT_MS = 3_000
const MAX_REPOS = 4
/** Only repos touched this recently are interesting — the rest is archaeology. */
const RECENT_MS = 18 * 60 * 60 * 1000

async function run(cmd: string[], cwd?: string, timeoutMs = PROBE_TIMEOUT_MS): Promise<string | undefined> {
  try {
    const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'ignore' })
    const timer = setTimeout(() => { try { proc.kill() } catch {} }, timeoutMs)
    const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
    clearTimeout(timer)
    return code === 0 ? out.trim() : undefined
  } catch {
    return undefined
  }
}

/** Frontmost GUI app. Needs Accessibility permission; undefined without it. */
export async function frontmostApp(): Promise<string | undefined> {
  const out = await run([
    'osascript', '-e',
    'tell application "System Events" to name of first process whose frontmost is true',
  ])
  return out || undefined
}

export async function repoState(dir: string): Promise<RepoState | undefined> {
  if (!existsSync(join(dir, '.git'))) return undefined
  const [branch, porcelain] = await Promise.all([
    run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], dir),
    run(['git', 'status', '--porcelain'], dir),
  ])
  if (porcelain === undefined) return undefined
  const dirty = porcelain ? porcelain.split('\n').filter(Boolean).length : 0
  return { name: dir.split('/').pop()!, ...(branch ? { branch } : {}), dirty }
}

/**
 * Repos under `root` whose working tree was touched recently, dirtiest first.
 * mtime on the directory is a crude proxy for "the user was in here", but it is free
 * — running git over 27 project folders on every brief rebuild is not.
 */
export async function recentRepos(root: string, now = Date.now()): Promise<RepoState[]> {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const candidates: string[] = []
  for (const name of entries) {
    if (name.startsWith('.')) continue
    const dir = join(root, name)
    try {
      const st = statSync(dir)
      if (!st.isDirectory()) continue
      if (now - st.mtimeMs > RECENT_MS) continue
      if (!existsSync(join(dir, '.git'))) continue
      candidates.push(dir)
    } catch {}
  }
  const states = await Promise.all(candidates.slice(0, 12).map(repoState))
  return states
    .filter((s): s is RepoState => s !== undefined)
    .sort((a, b) => b.dirty - a.dirty)
    .slice(0, MAX_REPOS)
}

export async function probeWorkspace(root?: string): Promise<Workspace> {
  const projects = root ?? process.env.OTTO_PROJECTS_DIR ?? join(homedir(), 'Documents', 'Projects')
  const [app, repos] = await Promise.all([frontmostApp(), recentRepos(projects)])
  return { ...(app ? { app } : {}), repos }
}

export function formatWorkspace(w: Workspace): string | undefined {
  const bits: string[] = []
  if (w.app) bits.push(`frontmost: ${w.app}`)
  for (const r of w.repos) {
    const branch = r.branch && r.branch !== 'main' ? ` on ${r.branch}` : ''
    bits.push(`${r.name}${branch}${r.dirty ? ` (${r.dirty} uncommitted)` : ''}`)
  }
  return bits.length ? bits.join('; ') : undefined
}

if (import.meta.main) {
  const w = await probeWorkspace()
  console.log(process.argv.includes('--json') ? JSON.stringify(w, null, 2) : formatWorkspace(w) ?? '(nothing)')
}
