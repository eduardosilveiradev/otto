/**
 * Stop the session's running turn from the app: Escape into its tmux pane
 * (run.sh), the same key the user would press in the terminal.
 *
 * Only a session that lives in tmux can be stopped, so the app is told in the
 * hello whether this server can (`canStop`), and shows no Stop button otherwise.
 * Nothing is sent when no turn is open: an Escape at the idle prompt would clear
 * whatever is being typed there. The stop counts only once the pane is back at
 * Claude Code's empty prompt; an interrupt doesn't run the Stop hook, so the
 * caller ends the turn itself on "stopped".
 */
import { existsSync } from 'fs'
import { atPrompt } from './nightreset.ts'

export type Tmux = (args: string[]) => Promise<{ ok: boolean; out: string }>

/** tmux on one state directory's own socket: a twin never reaches the live session. */
export const tmuxOn = (sock: string): Tmux => async args => {
  try {
    const p = Bun.spawn(['tmux', '-S', sock, ...args], { stdout: 'pipe', stderr: 'ignore' })
    const out = await new Response(p.stdout).text()
    return { ok: await p.exited === 0, out }
  } catch { return { ok: false, out: '' } }
}

// ponytail: the socket file says tmux was there, not that the session still is; a stale one offers a Stop that answers "failed".
export const canStop = (sock: string) => existsSync(sock)

export type StopDeps = { turnOpen(): boolean; tmux: Tmux; sleep(ms: number): Promise<void> }

/** "idle": no turn to stop. "failed": the key didn't go, or the pane never came back to the prompt. */
export async function stopTurn(d: StopDeps, target = 'otto'): Promise<'stopped' | 'idle' | 'failed'> {
  if (!d.turnOpen()) return 'idle'
  if (!(await d.tmux(['send-keys', '-t', target, 'Escape'])).ok) return 'failed'
  for (let i = 0; i < 10; i++) {
    await d.sleep(300)
    const pane = await d.tmux(['capture-pane', '-p', '-t', target])
    if (pane.ok && atPrompt(pane.out)) return 'stopped'
  }
  return 'failed'
}
