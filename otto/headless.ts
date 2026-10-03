/**
 * Arguments that keep a headless `claude -p` child from loading channel plugins.
 *
 * A bare `claude -p` loads every plugin the user has enabled, and each channel
 * plugin starts its own server. The Discord one has a single-instance guard
 * that kills whatever pid is on record and takes the gateway; when the headless
 * run exits, its server is orphaned and the live session is left disconnected.
 * Telegram had the same shape once (the two-poller bug) — OTTO_CHANNEL_HOST is
 * scrubbed for that, but scrubbing an env var only helps a server that reads it.
 *
 * `--strict-mcp-config` makes the child ignore every configured MCP server,
 * plugins included, and `--mcp-config` adds back exactly what the job needs:
 * this plugin's own server, named so the tool ids match the live session's
 * (`mcp__plugin_otto_otto__*`), or nothing at all.
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The claude CLI for headless children: whatever PATH finds (Homebrew, npm,
 * the native installer), else the native installer's default location. Callers
 * still check it exists — a missing CLI is a failed job, not a crash.
 */
export function claudeBin(): string {
  return Bun.which('claude') ?? join(homedir(), '.local', 'bin', 'claude')
}

/** Server name that yields the same `mcp__plugin_otto_otto__*` tool ids as the plugin does. */
export const HEADLESS_SERVER_NAME = 'plugin_otto_otto'

export type HeadlessMcpConfig = { mcpServers: Record<string, { command: string; args: string[] }> }

/** `otto:true` adds this plugin's server back so recall/remember stay reachable; `otto:false` adds nothing. */
export function headlessMcpConfig(opts: { otto: boolean }, dir: string = import.meta.dir): HeadlessMcpConfig {
  return {
    mcpServers: opts.otto
      ? { [HEADLESS_SERVER_NAME]: { command: 'bun', args: [join(dir, 'server.ts')] } }
      : {},
  }
}

/** argv fragment to append to every headless spawn. */
export function headlessMcpArgs(opts: { otto: boolean }, dir?: string): string[] {
  return ['--strict-mcp-config', '--mcp-config', JSON.stringify(headlessMcpConfig(opts, dir))]
}
