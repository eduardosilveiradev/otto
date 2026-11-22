/**
 * Sunday evening: open PRs older than three days across the user's own repos, one card.
 * Stacked PRs (base = another open PR's head) show as one chain in merge order. The taps
 * ("merge stack demo#3..#7", "merge PR demo#3", "close PR demo#1") re-read GitHub and do
 * the work: each PR merged with --merge in order, the next one retargeted first.
 */
import type { Exec } from './codejobs.ts'
import type { Card } from './cards.ts'
import type { ReplyButton } from './buttons.ts'

export const STALE_MS = 3 * 86_400_000
const DAY = 86_400_000

export type Pr = {
  number: number; title: string; body: string; createdAt: string
  baseRefName: string; headRefName: string; mergeable: string; isCrossRepository: boolean
}
export type Repo = { name: string; nameWithOwner: string; isArchived: boolean; defaultBranchRef: { name: string } | null; pullRequests: { nodes: Pr[] } }

// ponytail: first 100 repos by last push, 50 open PRs each; paginate if that ever falls short.
// One graphql call instead of `gh repo list` + a `gh pr list` per repo: one call against the budget, and it passes the outage gate.
const QUERY = `query { viewer { repositories(first: 100, ownerAffiliations: OWNER, isFork: false, orderBy: {field: PUSHED_AT, direction: DESC}) { nodes {
  name nameWithOwner isArchived defaultBranchRef { name }
  pullRequests(states: OPEN, first: 50) { nodes { number title body createdAt baseRefName headRefName mergeable isCrossRepository } }
} } } }`

export async function fetchRepos(exec: Exec): Promise<Repo[]> {
  const r = JSON.parse(await exec(['gh', 'api', 'graphql', '-f', `query=${QUERY}`], undefined, 30_000) ?? 'null')
  const nodes = r?.data?.viewer?.repositories?.nodes
  if (r?.errors?.length || !Array.isArray(nodes)) throw new Error('GitHub repo query failed')
  return (nodes as Repo[]).filter(x => x && !x.isArchived && Array.isArray(x.pullRequests?.nodes))
}

/** Linked over every open PR (a stale PR on a fresh parent is still stacked). Linear groups list in merge order. */
export function groups(prs: Pr[]): { prs: Pr[]; linear: boolean }[] {
  const own = prs.filter(p => !p.isCrossRepository)   // a fork's `main` is not this repo's `main`
  const kids = (p: Pr) => p.isCrossRepository ? [] : prs.filter(c => c !== p && c.baseRefName === p.headRefName)
  const isRoot = (p: Pr) => !own.some(o => o !== p && o.headRefName === p.baseRefName)
  const out: { prs: Pr[]; linear: boolean }[] = []
  const seen = new Set<Pr>()
  for (const root of prs.filter(isRoot)) {
    const g = [root]; let linear = true
    for (let i = 0; i < g.length; i++) {
      const k = kids(g[i]!).filter(c => !g.includes(c))
      if (k.length > 1) linear = false
      g.push(...k)
    }
    g.forEach(p => seen.add(p))
    out.push({ prs: g, linear })
  }
  for (const p of prs) if (!seen.has(p)) out.push({ prs: [p], linear: false })   // a loop: listed, never merged
  return out
}

const what = (p: Pr) => (p.title.trim() || p.body.split(/(?<=[.!?])\s|\n/)[0]!.trim() || 'no description').replace(/\s+/g, ' ')
const clip = (s: string, n: number) => Array.from(s).length > n ? Array.from(s).slice(0, n - 1).join('') + '…' : s
const state = (m: string) => m === 'MERGEABLE' ? 'merges clean' : m === 'CONFLICTING' ? 'conflicts' : 'not checked'

export type Sweep = { text: string; card: Card; buttons: ReplyButton[] }

export async function staleSweep(exec: Exec, now: number, wait = (ms: number) => Bun.sleep(ms)): Promise<Sweep | null> {
  const stale = (p: Pr) => now - Date.parse(p.createdAt) > STALE_MS
  let repos = await fetchRepos(exec)
  // GitHub computes mergeability lazily: a PR nobody looked at in days often reads UNKNOWN on first ask.
  if (repos.some(r => r.pullRequests.nodes.some(p => stale(p) && p.mergeable === 'UNKNOWN'))) {
    await wait(5_000)
    repos = await fetchRepos(exec)
  }
  const items: { title: string; detail: string; trailing: string }[] = []
  const merges: ReplyButton[] = [], closes: ReplyButton[] = []
  for (const repo of repos) {
    for (const g of groups(repo.pullRequests.nodes)) {
      if (!g.prs.some(stale)) continue
      g.prs.forEach((p, i) => items.push({
        title: clip(`${repo.name}#${p.number} ${what(p)}`, 120),
        detail: `${Math.floor((now - Date.parse(p.createdAt)) / DAY)}d old${g.prs.length > 1 ? ` · stack ${i + 1}/${g.prs.length}` : ''}`,
        trailing: state(p.mergeable),
      }))
      const [first, last] = [g.prs[0]!, g.prs.at(-1)!]
      const ok = g.linear && first.baseRefName === repo.defaultBranchRef?.name && g.prs.every(p => p.mergeable === 'MERGEABLE')
      if (ok && g.prs.length > 1) merges.push({ label: `merge the stack ${repo.name}#${first.number}..#${last.number}`, data: `merge stack ${repo.name}#${first.number}..#${last.number}` })
      else if (ok) merges.push({ label: `merge ${repo.name}#${first.number}`, data: `merge PR ${repo.name}#${first.number}` })
      if (g.prs.length === 1) closes.push({ label: `close ${repo.name}#${first.number}`, data: `close PR ${repo.name}#${first.number}` })
    }
  }
  if (!items.length) return null
  const blocks: Card['blocks'] = [{ type: 'list', items: items.slice(0, 20) }]
  if (items.length > 20) blocks.push({ type: 'text', text: `+${items.length - 20} more`, style: 'caption' })
  return {
    text: `${items.length === 1 ? 'a PR has' : `${items.length} PRs have`} been open more than three days`,
    card: { title: 'Stale PRs', blocks },
    buttons: [...merges, ...closes].filter(b => Buffer.byteLength(b.data!, 'utf8') <= 60).slice(0, 6),
  }
}

export const TAP_RE = /^(merge stack|merge PR|close PR) ([\w.-]+)#(\d+)(?:\.\.#(\d+))?$/

/**
 * Re-reads the repo, then walks up from the last PR to the stack's root. A half-merged stack
 * (an earlier tap stopped partway) resumes from wherever it now starts.
 */
export async function stalePrTap(exec: Exec, instruction: string): Promise<string | null> {
  const m = TAP_RE.exec(instruction.trim())
  if (!m || (m[1] === 'merge stack') !== !!m[4]) return null
  const [, verb, name, a, b = a] = m as unknown as [string, string, string, string, string?]
  const repo = (await fetchRepos(exec)).find(r => r.name === name)
  if (!repo) return `${name} isn't one of your repos any more`
  const prs = repo.pullRequests.nodes
  const R = ['-R', repo.nameWithOwner]
  const top = prs.find(p => p.number === Number(b))
  if (!top) return `${name}#${b} is no longer open`
  if (verb === 'close PR') {
    await exec(['gh', 'pr', 'close', b, ...R], undefined, 60_000)
    return `closed ${name}#${b}`
  }
  const chain = [top]
  for (let p = top; ;) {
    const parent = prs.find(o => !o.isCrossRepository && o !== p && o.headRefName === p.baseRefName)
    if (!parent || chain.includes(parent)) break
    chain.unshift(p = parent)
  }
  const base = repo.defaultBranchRef?.name
  const changed = `${name}#${a}..#${b} changed since the sweep; not merging`
  if (verb === 'merge PR' && chain.length > 1) return `${name}#${b} is stacked on #${chain.at(-2)!.number} now; not merging`
  if (!base || chain[0]!.baseRefName !== base) return changed
  if (chain.slice(0, -1).some(p => prs.filter(c => c.baseRefName === p.headRefName).length !== 1)) return changed
  if (prs.some(p => p.number === Number(a)) && !chain.some(p => p.number === Number(a))) return changed
  const conflicted = chain.find(p => p.mergeable === 'CONFLICTING')
  if (conflicted) return `${name}#${conflicted.number} has conflicts; nothing merged`
  const done: number[] = []
  for (const [i, p] of chain.entries()) {
    try {
      // Merge commits, never squash: the next PR's history has to contain this one's commits.
      if (i) await exec(['gh', 'pr', 'edit', String(p.number), ...R, '--base', base], undefined, 60_000)
      await exec(['gh', 'pr', 'merge', String(p.number), ...R, '--merge'], undefined, 120_000)
    } catch (err) {
      const why = String(err instanceof Error ? err.message : err).split('\n')[0]!.slice(0, 160)
      return `${done.length ? `merged ${done.map(n => `#${n}`).join(', ')}; ` : ''}stopped at ${name}#${p.number}: ${why}`
    }
    done.push(p.number)
  }
  return `merged ${name} ${done.map(n => `#${n}`).join(', ')} into ${base}`
}
