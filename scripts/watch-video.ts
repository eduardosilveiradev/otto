import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The installed watch-video skill: Claude Code's skills folder first, then Codex's. */
export function findWatchScript(home: string, exists: (path: string) => boolean = existsSync): string | undefined {
  return ['.claude', '.codex', '.Codex'].map(dir => join(home, dir, 'skills', 'watch-video', 'scripts', 'watch.sh')).find(exists)
}

export function instagramAuthFailure(url: string, error: string): boolean {
  let host: string
  try { host = new URL(url).hostname.toLowerCase() } catch { return false }
  return (host === 'instagram.com' || host.endsWith('.instagram.com'))
    && /login|log[ -]?in|sign[ -]?in|rate.?limit|too many requests|429|authentication|cookies|requested content is not available/i.test(error)
}

export async function watchVideo(args: string[], script: string): Promise<number> {
  // Capture diagnostics in memory only. In particular, never echo browser-cookie diagnostics.
  const run = async (extra: string[]) => {
    const child = Bun.spawn(['bash', script, ...args, ...extra], { stdout: 'inherit', stderr: 'pipe' })
    const error = await new Response(child.stderr).text()
    return { code: await child.exited, error }
  }
  let result = await run([])
  if (result.code && !args.includes('--cookies') && instagramAuthFailure(args[0] ?? '', result.error)) {
    process.stderr.write('Instagram requires a signed-in retry; using Chrome.\n')
    // watch.sh maps --cookies chrome to yt-dlp --cookies-from-browser chrome.
    result = await run(['--cookies', 'chrome'])
  }
  if (result.code) process.stderr.write('Video download failed; no readable video was saved.\n')
  return result.code
}

if (import.meta.main) {
  const script = process.env.OTTO_WATCH_VIDEO_SCRIPT ?? findWatchScript(homedir())
  if (script && existsSync(script)) process.exitCode = await watchVideo(process.argv.slice(2), script)
  else {
    process.stderr.write('The watch-video skill is not installed: nothing was downloaded. Set OTTO_WATCH_VIDEO_SCRIPT to its watch.sh.\n')
    process.exitCode = 2
  }
}
