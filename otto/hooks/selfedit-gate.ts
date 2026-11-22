/**
 * PreToolUse on Write, Edit, MultiEdit and NotebookEdit: the session's own file
 * writes go through classify() like the server's (SELFEDIT.md). Exit 2 refuses
 * the call and hands stderr to the model; anything else lets it run.
 *
 * Only Otto's own session (OTTO_CHANNEL_HOST=1, set by run.sh) is gated, and only
 * for paths writeScope() names; every other session and path passes without a
 * network call. The server decides, since it holds the origin stamp and the proof.
 * When it doesn't answer (restarting, down), a gated path whose tier needs a tap
 * or the phrase is refused: there is no proof to check, so it fails closed.
 * Routine state files pass then.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { hookPath, tierForPath, writeScope } from '../selfedit.ts'

const STATE_DIR = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')

function refuse(why: string): never {
  process.stderr.write(why + '\n')
  process.exit(2)
}

if (process.env.OTTO_CHANNEL_HOST !== '1') process.exit(0)
const body = await Bun.stdin.text()
let path = ''
try { path = hookPath(JSON.parse(body)) } catch {}
const scope = path ? writeScope(path, STATE_DIR, homedir()) : null
if (!scope) process.exit(0)

let res: Response | undefined
try {
  const url = readFileSync(join(STATE_DIR, 'status-url'), 'utf8').trim()
  res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Claude-Pid': process.env.OTTO_CLAUDE_PID ?? '', 'X-Otto-Hook': 'selfedit' },
    body,
    signal: AbortSignal.timeout(2000),
  })
} catch {}
if (res?.status === 204) process.exit(0)
if (res?.status === 403) refuse((await res.text().catch(() => '')) || 'self-edit blocked by the channel')
// Routine state passes: the origin it depends on lives in the server.
if (scope === 'gated' && tierForPath(path).tier !== 'unattended') {
  refuse(`self-edit blocked — the channel isn't answering, so nothing can prove the tap or the phrase ${path} needs. Try again once it's back.`)
}
