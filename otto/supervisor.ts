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
const inflight = new Set<string | number>()

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
    stdio: ['pipe', 'pipe', 'inherit'],
    env: { ...process.env, OTTO_SUPERVISED: '1' },
  })
  child = c

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
    for (const id of inflight) {
      toClient(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32000, message: 'otto restarted mid-request; try again' } }))
    }
    inflight.clear()
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

createInterface({ input: process.stdin })
  .on('line', line => {
    const m = parse(line)
    if (m?.method === 'initialize') init = m
    else if (m?.method === 'notifications/initialized') initialized = line
    if (m?.method !== undefined && m.id !== undefined) inflight.add(m.id)
    toChild(line)
  })
  .on('close', stop)

function stop() {
  if (stopping) return
  stopping = true
  if (!child) process.exit(0)
  child.stdin?.end()                       // server.ts shuts down when stdin ends
  setTimeout(() => child?.kill('SIGTERM'), 3000)
  setTimeout(() => process.exit(0), 6000)
}
process.on('SIGTERM', stop)
process.on('SIGINT', stop)
process.on('SIGHUP', stop)

start()
