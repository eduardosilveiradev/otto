/**
 * Where the user stopped, so the first ten minutes are not spent finding out.
 *
 * The Machine line in the brief answers "what is the user doing right now", which is
 * the wrong question at 09:00 because the answer is "nothing yet". The question
 * that morning is "what was I doing", and reconstructing it costs a lap through
 * three repos, `git log`, a diff, and whatever the test runner said last night.
 *
 * Everything needed is already on disk. This turns it into three lines: the
 * repo and branch, what the last commit was, how much is uncommitted, whether
 * the suite was failing when they walked away, and any TODO they left in the diff
 * itself — which is the closest thing to a note-to-self they actually write.
 *
 * It is a brief section, not a message. It costs no notification, and on a
 * morning where nothing is in flight it renders as nothing at all rather than
 * as a cheerful report that there is nothing to report.
 */

export type RepoState = {
  path: string
  name: string
  branch?: string
  /** Subject line of the most recent commit. */
  lastCommit?: string
  /** epoch ms of that commit. */
  lastCommitAt?: number
  filesChanged: number
  insertions: number
  deletions: number
  /** TODO/FIXME lines added in the uncommitted diff. */
  notes: string[]
  /** Name of a test that was failing in the last recorded run, if any. */
  failingTest?: string
}

/** `git log -1 --format=%s%x00%ct` */
export function parseLastCommit(out: string): { subject?: string; at?: number } {
  const [subject, ct] = out.trim().split('\0')
  if (!subject) return {}
  const at = Number(ct) * 1000
  return { subject: subject.trim(), ...(Number.isFinite(at) && at > 0 ? { at } : {}) }
}

/** `git diff --shortstat` and its staged twin, summed. */
export function parseShortstat(out: string): { filesChanged: number; insertions: number; deletions: number } {
  const files = /(\d+) files? changed/.exec(out)
  const ins = /(\d+) insertions?\(\+\)/.exec(out)
  const del = /(\d+) deletions?\(-\)/.exec(out)
  return {
    filesChanged: files ? Number(files[1]) : 0,
    insertions: ins ? Number(ins[1]) : 0,
    deletions: del ? Number(del[1]) : 0,
  }
}

/**
 * TODOs *added* in the working diff. Only added lines count: a TODO that has
 * been sitting in the file for a year is not a note about last night.
 */
export function parseDiffNotes(diff: string, limit = 3): string[] {
  const out: string[] = []
  for (const line of diff.split('\n')) {
    if (!line.startsWith('+') || line.startsWith('+++')) continue
    const m = /(?:TODO|FIXME|XXX|HACK)\b[:\s]*(.*)$/i.exec(line)
    if (!m) continue
    const text = (m[1] ?? '').trim().replace(/\*\/\s*$/, '').trim()
    if (text) out.push(text.slice(0, 100))
    if (out.length >= limit) break
  }
  return out
}

/**
 * The last failing test from a `bun test` tail. Bun prints "(fail) <name>"; the
 * most recent one wins, since a later pass does not un-fail an earlier line in
 * the same run.
 */
export function parseFailingTest(testOutput: string): string | undefined {
  const fails = [...testOutput.matchAll(/^\(fail\)\s+(.+?)(?:\s+\[[\d.]+m?s\])?$/gm)]
  if (!fails.length) return undefined
  return fails[fails.length - 1][1].trim()
}

export function isInteresting(r: RepoState): boolean {
  return r.filesChanged > 0 || r.notes.length > 0 || r.failingTest !== undefined
}

const ago = (ms: number): string => {
  const h = ms / 3_600_000
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`
  if (h < 36) return `${Math.round(h)}h ago`
  return `${Math.round(h / 24)}d ago`
}

/**
 * One line per repo that has something in flight. Repos with a clean tree and
 * nothing failing are omitted entirely: "nothing to resume" is best said by
 * saying nothing.
 */
export function formatResume(repos: RepoState[], now = Date.now()): string {
  const live = repos.filter(isInteresting)
  if (!live.length) return ''
  const lines = live.map(r => {
    const bits: string[] = [`${r.name}${r.branch ? ` (${r.branch})` : ''}`]
    if (r.filesChanged) {
      bits.push(`${r.filesChanged} file${r.filesChanged === 1 ? '' : 's'} uncommitted, +${r.insertions}/-${r.deletions}`)
    }
    if (r.lastCommit) {
      const when = r.lastCommitAt ? `, ${ago(now - r.lastCommitAt)}` : ''
      bits.push(`last: "${truncate(r.lastCommit, 60)}"${when}`)
    }
    if (r.failingTest) bits.push(`failing: ${truncate(r.failingTest, 60)}`)
    const head = bits.join(' · ')
    const notes = r.notes.length ? `\n    left a note: ${r.notes.map(n => truncate(n, 70)).join(' / ')}` : ''
    return `  ${head}${notes}`
  })
  return `Where you left off:\n${lines.join('\n')}`
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}
