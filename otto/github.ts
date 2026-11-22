/** Shared outage gate and call budget for GitHub readers. */
import { CommandError, runChecked } from './workspace.ts'
import type { Exec } from './codejobs.ts'
import { homedir } from 'os'
import { join } from 'path'
import { saveState } from './statefile.ts'

export type GithubStatus = { reachable: boolean; since?: string; detail?: string }
const PROBE_MS = 5 * 60_000
const WINDOW_MS = 10 * 60_000
/** A runaway brake, not a budget: one PR detail load makes a call per commit, so 30 starved the PR viewer. */
export const CALL_CAP = 300
export class Github {
  status: GithubStatus = { reachable: true }
  private probe?: Promise<void>
  private probedAt = -Infinity
  private calls: number[] = []
  private capped = false
  constructor(private exec: Exec = runChecked, private now = Date.now, private record?: (calls: number[]) => void) {}
  private counted: Exec = async (...args) => {
    const now = this.now()
    this.calls = this.calls.filter(at => at > now - 3_600_000)
    if (this.calls.filter(at => at > now - WINDOW_MS).length >= CALL_CAP) {
      if (!this.capped) console.warn(`[github] ${CALL_CAP} calls / 10 min reached; skipping until the window clears`)
      this.capped = true
      throw new Error('GitHub call budget reached')
    }
    this.capped = false
    this.calls.push(now)
    try { this.record?.([...this.calls]) } catch { console.warn('[github] could not save call counter') }
    return this.exec(...args)
  }
  private success() { this.status = { reachable: true } }
  private failed() {
    this.status = { reachable: false, since: this.status.since ?? new Date(this.now()).toISOString(), detail: 'GitHub API connection failed or timed out' }
  }
  private network(e: unknown) {
    return e instanceof CommandError && (e.timedOut || /(?:could not resolve|connect(?:ion|ing)|network|timeout|timed out|TLS handshake|no route|EOF)/i.test(e.stderr))
  }
  private async confirm() {
    if (this.probe) return this.probe
    if (this.now() - this.probedAt < PROBE_MS) return
    this.probedAt = this.now()
    this.probe = (async () => {
      try {
        const out = await this.counted(['gh', 'api', 'rate_limit'], undefined, 3_000)
        if (out === undefined) this.failed()
        else this.success()
      } catch (e) {
        if (this.network(e)) this.failed()
        else if (e instanceof CommandError && /HTTP \d{3}/.test(e.stderr)) this.success()
      }
    })().finally(() => { this.probe = undefined })
    await this.probe
  }
  async refresh(): Promise<void> { if (!this.status.reachable) await this.confirm() }
  run: Exec = async (cmd, cwd, timeout) => {
    if (cmd[0] !== 'gh') return this.exec(cmd, cwd, timeout)
    if (!['pr', 'api', 'search'].includes(cmd[1] ?? '')) return this.counted(cmd, cwd, timeout)
    if (!this.status.reachable) {
      await this.confirm()
      if (!this.status.reachable) throw new Error('GitHub is unreachable')
    }
    try {
      const out = await this.counted(cmd, cwd, timeout)
      if (out === undefined) {
        this.failed()
        await this.confirm()
        throw new Error('GitHub returned no data (command failed or timed out)')
      }
      this.success()
      return out
    } catch (e) {
      if (this.network(e)) { this.failed(); await this.confirm() }
      else if (e instanceof CommandError && /HTTP \d{3}|no pull requests found/i.test(e.stderr)) this.success()
      throw e
    }
  }
}
/** All production pollers share one gate, budget and rolling-hour counter. */
export const github = new Github(runChecked, Date.now, calls => {
  saveState(join(process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state'), 'github-calls.json'), { calls })
})
