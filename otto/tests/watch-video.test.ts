import { test, expect } from 'bun:test'
import { findWatchScript, instagramAuthFailure, watchVideo } from '../../scripts/watch-video.ts'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

test('Chrome retry is restricted to Instagram auth/rate-limit errors', () => {
  expect(instagramAuthFailure('https://www.instagram.com/reel/example/', 'Please log in')).toBe(true)
  expect(instagramAuthFailure('https://instagram.com/reel/example/', 'HTTP Error 429')).toBe(true)
  expect(instagramAuthFailure('https://instagram.com/reel/example/', 'No space left')).toBe(false)
  expect(instagramAuthFailure('https://instagram.com.example.com/', 'login')).toBe(false)
  expect(instagramAuthFailure('file.mp4', 'login')).toBe(false)
})

test('failed watch retries once with Chrome while preserving options', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-test-'))
  try {
    const script = join(dir, 'watch.sh')
    writeFileSync(script, 'printf "%s\\n" "$*" >> "$(dirname "$0")/calls"\ncase "$*" in *"--cookies chrome"*) exit 0;; esac\necho "Instagram login required" >&2\nexit 1\n')
    expect(await watchVideo(['https://instagram.com/reel/example/', '--frames', '40'], script)).toBe(0)
    expect(readFileSync(join(dir, 'calls'), 'utf8').trim().split('\n')).toEqual([
      'https://instagram.com/reel/example/ --frames 40',
      'https://instagram.com/reel/example/ --frames 40 --cookies chrome',
    ])
  } finally { rmSync(dir, { recursive: true }) }
})

test('finds the installed skill, preferring Claude Code over Codex', () => {
  const path = (dir: string) => `/home/${dir}/skills/watch-video/scripts/watch.sh`
  expect(findWatchScript('/home', p => p === path('.Codex'))).toBe(path('.Codex'))
  expect(findWatchScript('/home', p => p === path('.Codex') || p === path('.claude'))).toBe(path('.claude'))
  expect(findWatchScript('/home', () => false)).toBeUndefined()
})
