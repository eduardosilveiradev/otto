#!/usr/bin/env bun
// Holds Claude Code's stdio connection while the real server restarts under it.
//
// Claude Code talks MCP to this process; this process runs server.ts as a child
// and passes newline-delimited JSON-RPC both ways. When the child exits (the
// `reload` tool, or a crash), a fresh one starts on the code now on disk: it is
// handed the session's original `initialize` (its reply swallowed — the client
// already has one), then `notifications/initialized`, then anything that queued
// meanwhile, and the client is told the tool list may have changed.
//
// The next child starts only after the last one has exited, so it never fights
// its predecessor for the Telegram poller or the webhook port. Requests that were
// in flight when a child died are answered with an error rather than left hanging.
// Three deaths within 10s of starting each and it gives up: Claude Code then shows
// the server as failed, which is the honest state.
import { markRestart, failRestart, readRestart, restartStateDir } from './restart.ts'
import { spawn, type ChildProcess } from 'child_process'
import { join } from 'path'
import { createInterface } from 'readline'

const SERVER = process.env.OTTO_SERVER_ENTRY ?? join(import.meta.dir, 'server.ts')
const REPLAY_ID = '__otto_supervisor_init__'

let child: ChildProcess | null = null
let ready = false
let stopping = false
let fastDeaths = 0
let init: Record<string, unknown> | null = null
let initialized: string | null = null
const queue: string[] = []
/** Requests the child hasn't answered, with what each one was (a tool's name). */
const inflight = new Map<string | number, string>()

const toClient = (msg: string) => process.stdout.write(msg + '\n')
const log = (s: string) => process.stderr.write(`otto supervisor: ${s}\n`)
const parse = (line: string): any => { try { return JSON.parse(line) } catch { return null } }

function toChild(line: string) {
  if (ready && child?.stdin?.writable) child.stdin.write(line + '\n')
  else queue.push(line)
}

function start() {
  const started = Date.now()
  const replay = init !== null
  ready = !replay
  const c = spawn(process.execPath, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, OTTO_SUPERVISED: '1' },
  })
  child = c
  let errorAt = 0
  let stderrTail = ''
  c.stderr!.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk)
    stderrTail = (stderrTail + chunk.toString()).slice(-8192)
    if (/(?:Error|Exception)\s*:|uncaught|unhandled rejection/i.test(stderrTail)) {
      errorAt = Date.now()
      stderrTail = ''
    }
  })

  createInterface({ input: c.stdout! }).on('line', line => {
    const m = parse(line)
    if (m?.id === REPLAY_ID) {
      ready = true
      if (initialized) c.stdin!.write(initialized + '\n')
      for (const q of queue.splice(0)) c.stdin!.write(q + '\n')
      toClient(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/tools/list_changed' }))
      log(`server ${c.pid} up`)
      return
    }
    if (m && m.id !== undefined && m.method === undefined) inflight.delete(m.id)
    toClient(line)
  })

  if (replay) c.stdin!.write(JSON.stringify({ ...init, id: REPLAY_ID }) + '\n')

  c.on('exit', (code, signal) => {
    if (child === c) { child = null; ready = false }
    // A write may have landed before the exit (a job started, a message sent): a blind retry repeats it.
    for (const [id, what] of inflight) {
      toClient(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: `otto restarted while ${what} was running; it may already have taken effect, so check before trying again` } }))
    }
    inflight.clear()
    const intent = readRestart(restartStateDir())
    if ((code !== 0 && !(stopping && signal)) || (intent && errorAt >= intent.at)) failRestart(restartStateDir())
    if (stopping) process.exit(0)
    fastDeaths = Date.now() - started < 10_000 ? fastDeaths + 1 : 0
    if (fastDeaths >= 3) {
      log(`server died ${fastDeaths} times straight (last: ${signal ?? code}) — giving up`)
      process.exit(1)
    }
    log(`server exited (${signal ?? code}) — restarting`)
    setTimeout(start, fastDeaths * 1000)
  })
}

/** A T3 Code thread (a coding job or one of its council seats) never uses Otto's tools, and each
 *  server it would start holds ~200 MB and a voice daemon. It gets an empty tool list instead.
 *  OTTO_IN_T3=1 brings the real server back for a thread that needs it. */
const inT3 = process.env.CLAUDE_CODE_ENTRYPOINT === 't3-code' && process.env.OTTO_IN_T3 !== '1'
function serveNothing() {
  createInterface({ input: process.stdin })
    .on('line', line => {
      const m = parse(line)
      if (m?.id === undefined || !m.method) return
      const result = m.method === 'initialize'
        ? { protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'otto', version: 'off-in-t3' } }
        : m.method === 'tools/list' ? { tools: [] } : null
      toClient(JSON.stringify(result ? { jsonrpc: '2.0', id: m.id, result } : { jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'otto is off in T3 Code threads' } }))
    })
    .on('close', () => process.exit(0))
}

if (inT3) serveNothing()
else createInterface({ input: process.stdin })
  .on('line', line => {
    const m = parse(line)
    if (m?.method === 'initialize') init = m
    else if (m?.method === 'notifications/initialized') initialized = line
    if (m?.method !== undefined && m.id !== undefined) inflight.set(m.id, typeof m.params?.name === 'string' ? m.params.name : m.method)
    toChild(line)
  })
  .on('close', stop)

function stop() {
  if (inT3) process.exit(0)
  if (stopping) return
  markRestart(restartStateDir(), 'supervisor stop')
  stopping = true
  if (!child) process.exit(0)
  child.stdin?.end()                       // server.ts shuts down when stdin ends
  setTimeout(() => child?.kill('SIGTERM'), 3000)
  setTimeout(() => process.exit(0), 6000)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('SIGHUP', stop)

if (!inT3) start()
