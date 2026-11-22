/**
 * SessionStart after a compaction or /clear: print the user's rules so they are
 * back in context at once instead of waiting for a lucky recall. Stdout becomes
 * session context. Reads memory files only; no network, never blocks the session.
 */
import { loadMemories } from '../memory.ts'
import { sessionRules } from '../houserules.ts'

let cwd = process.cwd()
try { cwd = JSON.parse(await Bun.stdin.text()).cwd || cwd } catch {}
try {
  const block = sessionRules(loadMemories(true), cwd)
  if (block) process.stdout.write(block + '\n')
} catch {}
