/**
 * T3 Code, as codejobs.ts needs it: list projects, start a thread on a new worktree, read how
 * a thread is doing, post into it, answer what it asked, interrupt it.
 *
 * T3's own server (127.0.0.1:3773 by default; ~/.t3/userdata/server-runtime.json says where it
 * really is) speaks Effect RPC over one websocket, /ws?orchestrationProtocol=2, one JSON message
 * per frame:
 *   → {_tag:"Request", id, tag, payload, headers:[]}
 *   ← {_tag:"Exit", requestId, exit:{_tag:"Success", value} | {_tag:"Failure", cause}}
 *   ← {_tag:"Chunk", requestId, values:[…]}   a stream; each one must be acked, or it stalls
 * The bearer is a T3 session token with orchestration:read and :operate, minted with T3's own
 * CLI (`t3 auth session issue`) the first time it's needed and kept in t3-token (0600). That
 * token can't reach T3's /mcp (which wants its OAuth credential); the websocket does it all.
 *
 * If the websocket can't be reached, thread state is read from T3's database instead, opened
 * read-only. Nothing here ever writes to it.
 */
import { Database } from 'bun:sqlite'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { randomUUID } from 'crypto'
import type { LaunchInput, PhotoAttachment, T3, T3Project, ThreadSnap } from './codejobs.ts'
import type { Effort } from './route.ts'

const STATE_DIR = process.env.OTTO_STATE_DIR ?? join(homedir(), '.otto', 'state')
const T3_HOME = process.env.T3CODE_HOME ?? join(homedir(), '.t3')
const RPC_TIMEOUT_MS = 20_000

/** `OTTO_T3_HOST`: the ssh alias of the machine T3 Code runs on, when it isn't this one. */
export const t3Host = (): string | undefined => process.env.OTTO_T3_HOST || undefined
/** POSIX single-quoting for a remote shell. */
export const shq = (s: string): string => `'${s.replaceAll("'", `'\\''`)}'`
/** `ssh <host> -- <cmd>`, every argument quoted for the remote shell. */
export const sshCmd = (host: string, cmd: string[]): string[] => ['ssh', '-o', 'BatchMode=yes', host, '--', cmd.map(shq).join(' ')]

export function t3Origin(): string {
  if (process.env.OTTO_T3_URL) return process.env.OTTO_T3_URL.replace(/\/$/, '')
  try { return JSON.parse(readFileSync(join(T3_HOME, 'userdata', 'server-runtime.json'), 'utf8')).origin ?? 'http://127.0.0.1:3773' } catch { return 'http://127.0.0.1:3773' }
}

/** T3 desktop's promptLinks handler accepts t3code://threads/<environment>/<thread>. */
export function t3ThreadUrl(threadId: string | undefined, environmentFile = join(T3_HOME, 'userdata', 'environment-id')): string | null {
  if (!threadId) return null
  try {
    const environmentId = readFileSync(environmentFile, 'utf8').trim()
    return environmentId ? `t3code://threads/${encodeURIComponent(environmentId)}/${encodeURIComponent(threadId)}` : null
  } catch { return null }
}

/** "claude-opus-5-5" → "Opus 5.5", "gpt-6.2-sol" → "GPT 6.2 Sol". Anything else is shown as T3 names it. */
export function modelLabel(model: string | undefined, effort?: string): string | undefined {
  if (effort && model) return / · (low|medium|high|xhigh|max)$/.test(model) ? model : `${modelLabel(model)} · ${effort}`
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?/.exec(model ?? '')
  if (m) return `${m[1]![0]!.toUpperCase()}${m[1]!.slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`
  // "gpt-6.2-sol" → "GPT 6.2 Sol"
  const g = /^gpt-([\d.]+)((?:-[a-z]+)*)$/.exec(model ?? '')
  return g ? ['GPT', g[1], ...g[2]!.split('-').filter(Boolean).map(w => w[0]!.toUpperCase() + w.slice(1))].join(' ') : model
}

type Shell = Record<string, any>
type Rpc = { call: (tag: string, payload: unknown) => Promise<any>; first: (tag: string, payload: unknown) => Promise<any>; close: () => void }

export type T3Opts = {
  origin?: string
  tokenFile?: string
  /** Mints a fresh session token. Defaults to `t3 auth session issue`; tests pass their own. */
  mint?: () => Promise<string | undefined>
  /** T3's state database, read only when the websocket is down. */
  db?: string
}

async function mintWithCli(scopes = ['orchestration:read', 'orchestration:operate'], label = 'otto'): Promise<string | undefined> {
  const host = t3Host()
  // Over ssh the remote shell starts in the T3 machine's home, so the default CLI path is relative to it.
  const cli = process.env.OTTO_T3_CLI ?? (host ? '.t3/bin/t3' : join(T3_HOME, 'bin', 't3'))
  if (!host && !existsSync(cli)) return undefined
  const cmd = [cli, 'auth', 'session', 'issue', ...scopes.flatMap(s => ['--scope', s]), '--ttl', '30d', '--label', label, '--token-only']
  const p = Bun.spawn(host ? sshCmd(host, cmd) : cmd, { stdout: 'pipe', stderr: 'ignore', timeout: 20_000 })
  const out = (await new Response(p.stdout).text()).trim()
  return (await p.exited) === 0 && /^\S{20,}$/.test(out) ? out : undefined
}

export class T3Client implements T3 {
  private origin: string
  private tokenFile: string
  private mint: () => Promise<string | undefined>
  private db: string

  constructor(o: T3Opts = {}) {
    this.origin = o.origin ?? t3Origin()
    this.tokenFile = o.tokenFile ?? join(STATE_DIR, 't3-token')
    this.mint = o.mint ?? mintWithCli
    this.db = o.db ?? join(T3_HOME, 'userdata', 'statev2.sqlite')
  }

  private async token(fresh = false): Promise<string> {
    if (!fresh) try { const t = readFileSync(this.tokenFile, 'utf8').trim(); if (t) return t } catch {}
    const t = await this.mint()
    if (!t) throw new Error('no T3 Code token: the t3 CLI is missing or refused to issue one')
    writeFileSync(this.tokenFile, t + '\n', { mode: 0o600 })
    return t
  }

  private open(token: string): Promise<Rpc> {
    const ws = new WebSocket(`${this.origin.replace(/^http/, 'ws')}/ws?orchestrationProtocol=2`, { headers: { authorization: `Bearer ${token}` } } as any)
    let n = 0
    const waiting = new Map<string, { ok: (v: any) => void; no: (e: Error) => void; stream: boolean }>()
    const fail = (e: Error) => { for (const w of waiting.values()) w.no(e); waiting.clear() }
    ws.onmessage = e => {
      let m: any
      try { m = JSON.parse(String(e.data)) } catch { return }
      const w = waiting.get(m.requestId)
      if (m._tag === 'Chunk') {
        ws.send(JSON.stringify({ _tag: 'Ack', requestId: m.requestId }))
        if (w?.stream) { waiting.delete(m.requestId); ws.send(JSON.stringify({ _tag: 'Interrupt', requestId: m.requestId })); w.ok(m.values?.[0]) }
      } else if (m._tag === 'Exit' && w) {
        waiting.delete(m.requestId)
        if (m.exit?._tag === 'Success') w.ok(m.exit.value)
        else w.no(new Error(`T3 ${failureText(m.exit?.cause)}`))
      }
    }
    ws.onclose = () => fail(new Error('T3 Code closed the connection mid-request (did it restart?)'))
    const send = (tag: string, payload: unknown, stream: boolean) => new Promise<any>((ok, no) => {
      const id = String(++n)
      const timer = setTimeout(() => { waiting.delete(id); no(new Error(`T3 ${tag} timed out after ${RPC_TIMEOUT_MS / 1000} s (T3 Code may be busy)`)) }, RPC_TIMEOUT_MS)
      waiting.set(id, { ok: v => { clearTimeout(timer); ok(v) }, no: e => { clearTimeout(timer); no(e) }, stream })
      ws.send(JSON.stringify({ _tag: 'Request', id, tag, payload, headers: [] }))
    })
    return new Promise((ok, no) => {
      const timer = setTimeout(() => { try { ws.close() } catch {}; no(new Error(`T3 Code did not answer at ${this.origin} within 5 s; is it running?`)) }, 5_000)
      ws.onopen = () => { clearTimeout(timer); ok({ call: (t, p) => send(t, p, false), first: (t, p) => send(t, p, true), close: () => { try { ws.close() } catch {} } }) }
      ws.onerror = () => { clearTimeout(timer); no(new Error(`T3 Code refused the connection at ${this.origin}; is it running?`)) }
    })
  }

  /** One connection per use. A refused upgrade gets one fresh token: the old one may have expired. */
  private async rpc<T>(fn: (r: Rpc) => Promise<T>): Promise<T> {
    let r: Rpc
    try { r = await this.open(await this.token()) } catch (err) {
      // Down is down; a fresh token only helps a server that is up and turned the old one away.
      if (!(await fetch(this.origin, { signal: AbortSignal.timeout(2_000) }).then(() => true, () => false))) throw err
      r = await this.open(await this.token(true))
    }
    try { return await fn(r) } finally { r.close() }
  }

  /** Read freshness before the snapshot; lazy callers load withheld bodies on expansion. */
  async transcriptRead(threadId: string, cachedUpdatedAt?: string, lazy = false): Promise<{ updatedAt: string; projection?: Record<string, any> }> {
    let token = await this.token()
    const get = async (path: string): Promise<any> => {
      const request = () => fetch(`${this.origin}/api/orchestration/${path}`, {
        headers: { authorization: `Bearer ${token}`, 'x-t3-orchestration-protocol': '2' },
        signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      })
      let res = await request()
      if (res.status === 401) { await res.body?.cancel(); token = await this.token(true); res = await request() }
      if (!res.ok) { await res.body?.cancel(); throw new Error(`T3 transcript request failed (${res.status})`) }
      return res.json()
    }
    const bounded = await get(`threads/${encodeURIComponent(threadId)}/bounded`)
    const thread = bounded.projection?.thread
    if (thread?.updatedAt && thread.updatedAt === cachedUpdatedAt) return { updatedAt: thread.updatedAt }
    const snapshot = await get(`threads/${encodeURIComponent(threadId)}`)
    const p = snapshot.projection
    if (!p || !Array.isArray(p.turnItems)) throw new Error('T3 returned an invalid full snapshot')
    const rows = [...p.turnItems, ...(p.visibleTurnItems ?? []).map((r: any) => r.item)]
    const omitted = new Map(rows.filter((i: any) => i.outputOmitted || ['dynamic_tool', 'file_change', 'subagent'].includes(i.type)).map((i: any) => [`${i.threadId}:${i.id}`, i]))
    if (lazy) for (const item of rows) if (omitted.has(`${item.threadId}:${item.id}`)) item.bodyOmitted = true
    if (!lazy && omitted.size) await this.rpc(async r => {
      // Sequential reads bound server work and memory, even for very long threads.
      for (const item of omitted.values()) {
        const full = await r.call('orchestration.getTurnItem', { threadId: item.threadId ?? threadId, itemId: item.id })
        if (!full?.item) throw new Error('T3 omitted a tool body that could not be loaded')
        for (const row of rows) if (row.id === item.id && row.threadId === item.threadId) Object.assign(row, full.item, { outputOmitted: false })
      }
    })
    // Cache against the bounded read BEFORE the snapshot: a concurrent update may cause
    // one extra refresh, but cannot hide changes made during the snapshot read.
    return { updatedAt: thread?.updatedAt ?? p.updatedAt, projection: p }
  }

  async transcriptItem(threadId: string, itemId: string): Promise<Record<string, any>> {
    return this.rpc(async r => {
      const full = await r.call('orchestration.getTurnItem', { threadId, itemId })
      if (!full?.item) throw new Error('T3 tool body could not be loaded')
      return { ...full.item, threadId, outputOmitted: false, bodyOmitted: false }
    })
  }

  /**
   * What the app's Usage page reads: every provider's plan windows (server.getConfig, the same
   * bars T3's composer draws) and the per-day token buckets of T3's transcript scan
   * (server.getUsageSummary). Each settles on its own, so one failing leaves the other.
   */
  /** Every provider's plan windows only (server.getConfig), for the usage log. */
  async providers(): Promise<any[]> {
    return this.rpc(async r => (await r.call('server.getConfig', {}))?.providers ?? [])
  }

  async usage(q: { sinceDay: string; untilDay: string; timeZone: string }): Promise<{ providers: PromiseSettledResult<any[]>; summary: PromiseSettledResult<any> }> {
    try {
      return await this.rpc(async r => {
        const [config, summary] = await Promise.allSettled([r.call('server.getConfig', {}), r.call('server.getUsageSummary', q)])
        return { providers: config.status === 'fulfilled' ? { status: 'fulfilled' as const, value: config.value?.providers ?? [] } : config, summary }
      })
    } catch (reason) {
      return { providers: { status: 'rejected', reason }, summary: { status: 'rejected', reason } }
    }
  }

  private async shells(r: Rpc): Promise<{ projects: Shell[]; threads: Shell[] }> {
    const first = await r.first('orchestration.subscribeShell', {})
    const s = first?.snapshot
    if (!s) throw new Error('T3 sent no snapshot')
    return { projects: s.projects ?? [], threads: [...(s.threads ?? []), ...(s.archivedThreads ?? [])] }
  }

  async projects(): Promise<T3Project[]> {
    return this.rpc(async r => {
      const { projects, threads } = await this.shells(r)
      return projects.filter(p => !p.deletedAt).map(p => ({ id: p.id, name: p.title, root: p.workspaceRoot, model: pickModel(undefined, p, threads.filter(t => t.projectId === p.id), threads)?.model }))
    })
  }

  /** The last projection of each thread that wasn't running, trimmed to what snapFrom reads, by its shell's updatedAt. */
  private projections = new Map<string, { updatedAt: string; p: Shell }>()

  async threads(ids: string[]): Promise<Map<string, ThreadSnap>> {
    const out = new Map<string, ThreadSnap>()
    if (!ids.length) return out
    try {
      return await this.rpc(async r => {
        const byId = new Map((await this.shells(r)).threads.map(t => [t.id, t]))
        // One projection at a time took 20 threads × T3's latency, each allowed 20 s. Now a few share
        // the socket, a finished thread T3 hasn't touched reuses its last one, and after one timeout
        // the rest make do with what is known.
        const todo = [...ids]
        let slow = false, dead = false
        const worker = async () => {
          for (let id = todo.shift(); id !== undefined; id = todo.shift()) {
            const shell = byId.get(id)
            if (!shell || shell.deletedAt) { out.set(id, { id, status: 'gone' }); continue }
            const known = this.projections.get(id)
            const idle = !RUNNING.has(shell.activityRunStatus ?? shell.status) && !shell.pendingRuntimeRequest
            let p = idle && shell.updatedAt && known?.updatedAt === shell.updatedAt ? known.p : undefined
            // A pending question is still read: without it the card says only "it asked you something", and the real
            // text on the next read would raise a second attention event for the same question.
            // A closed socket answers nothing more: every call on it would wait out its 20 s.
            if (!p && !dead && (!slow || shell.pendingRuntimeRequest?.kind === 'user_input')) p = await r.call('orchestration.getThreadProjection', { threadId: id }).catch(e => {
              dead ||= /closed the connection/.test(String(e)); slow ||= dead || /timed out/.test(String(e)); return undefined
            })
            if (p && idle && shell.updatedAt && p !== known?.p) this.keep(id, shell.updatedAt, p)
            // Never an outdated projection: an answered question in it would read as a new one.
            out.set(id, snapFrom(shell, p))
          }
        }
        await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker))
        return new Map(ids.map(id => [id, out.get(id)!]))
      })
    } catch (err) {
      const fromDb = this.dbThreads(ids)
      if (fromDb) return fromDb
      throw err
    }
  }

  private keep(id: string, updatedAt: string, p: Shell): void {
    this.projections.delete(id)
    this.projections.set(id, { updatedAt, p: {
      turnItems: (p.turnItems ?? []).filter((i: Shell) => i.type === 'user_input_request' || (i.status === 'running' && i.title)).slice(-10),
      messages: [(p.messages ?? []).findLast((m: Shell) => m.role === 'assistant' && m.text)].filter(Boolean),
      providerTurns: (p.providerTurns ?? []).map((t: Shell) => ({ tokenUsage: { usedTokens: t.tokenUsage?.usedTokens ?? 0 } })),
      runs: (p.runs ?? []).slice().sort((a: Shell, b: Shell) => b.ordinal - a.ordinal).slice(0, 1),
    } })
    // ponytail: insertion-order cap; jobs are pruned after 14 days, so 200 covers every live one.
    if (this.projections.size > 200) this.projections.delete(this.projections.keys().next().value!)
  }

  /** The read-only fallback: status and branch from T3's own tables. */
  private dbThreads(ids: string[]): Map<string, ThreadSnap> | undefined {
    // T3 on another machine: its database isn't on this disk, so the fallback is skipped.
    if (t3Host() || !existsSync(this.db)) return undefined
    let db: Database | undefined
    try {
      db = new Database(this.db, { readonly: true })
      const out = new Map<string, ThreadSnap>()
      const row = db.query('SELECT payload_json, deleted_at FROM orchestration_v2_projection_threads WHERE thread_id = ?')
      const run = db.query('SELECT status, requested_at FROM orchestration_v2_projection_runs WHERE thread_id = ? ORDER BY ordinal DESC LIMIT 1')
      for (const id of ids) {
        const t = row.get(id) as { payload_json: string; deleted_at: string | null } | null
        if (!t || t.deleted_at) { out.set(id, { id, status: 'gone' }); continue }
        const shell = JSON.parse(t.payload_json)
        const latest = run.get(id) as { status: string; requested_at?: string } | null
        shell.status ??= latest?.status
        shell.runRequestedAt = latest?.requested_at
        out.set(id, snapFrom(shell, undefined))
      }
      return out
    } catch { return undefined } finally { db?.close() }
  }

  async launch(o: LaunchInput): Promise<{ threadId: string; branch?: string; model?: string; worktreePath?: string }> {
    return this.rpc(async r => {
      const { projects, threads } = await this.shells(r)
      const project = projects.find(p => p.id === o.projectId)
      const modelSelection = pickModel(o.model, project, threads.filter(t => t.projectId === o.projectId), threads)
      if (!modelSelection) throw new Error('no model to start the thread with: pass one, or set a default on the T3 project')
      if (o.effort !== undefined) {
        const config = await r.call('server.getConfig', {})
        modelSelection.options = effortOptions(modelSelection, o.effort, config.providers ?? [])
      }
      const res = await r.call('orchestration.launchThread', {
        commandId: randomUUID(), creationSource: 'mcp', projectId: o.projectId, title: o.title,
        modelSelection, runtimeMode: 'full-access', interactionMode: 'default',
        workspaceStrategy: { type: 'worktree', baseRef: o.baseRef ?? 'main', branch: o.branch, startFromOrigin: true },
        initialMessage: { messageId: randomUUID(), text: o.brief, attachments: [] },
      }).catch((e: Error) => {
        // Named, so codejobs can tell "T3 may have it" from a failure before anything was sent.
        throw /closed the connection/.test(e.message) ? new Error(`T3 orchestration.launchThread lost its connection: ${e.message}`) : e
      })
      const t = res?.projection?.thread ?? {}
      return { threadId: res.threadId, branch: t.branch ?? o.branch, model: modelLabel(t.modelSelection?.model ?? modelSelection.model, o.effort), ...(t.worktreePath ? { worktreePath: String(t.worktreePath) } : {}) }
    })
  }

  async repoint(projectId: string, root: string): Promise<void> {
    await this.rpc(r => r.call('projects.mutate', { type: 'project.update', commandId: randomUUID(), projectId, workspaceRoot: root }))
  }

  async send(threadId: string, text: string, attachments: PhotoAttachment[] = []): Promise<void> {
    await this.rpc(async r => {
      const shell = (await this.shells(r)).threads.find(t => t.id === threadId)
      if (!shell) throw new Error('T3 has no such thread')
      // Mid-turn, deliveryIntent 'auto' lets T3 steer the running turn when the provider can,
      // and fall back to queueing behind it when it can't; otherwise it starts a turn.
      const dispatchMode = shell.activeRunId ? { type: 'queue_after_active' } : { type: 'start_immediately' }
      await r.call('orchestration.dispatchCommand', {
        type: 'message.dispatch', commandId: randomUUID(), createdBy: 'user', creationSource: 'mcp',
        threadId, messageId: randomUUID(), text, attachments, dispatchMode,
        ...(shell.activeRunId ? { deliveryIntent: 'auto' } : {}),
      })
    })
  }

  async answer(threadId: string, text: string, attachments: PhotoAttachment[] = []): Promise<boolean> {
    return this.rpc(async r => {
      const shell = (await this.shells(r)).threads.find(t => t.id === threadId)
      const req = shell?.pendingRuntimeRequest
      if (!req?.id) return false
      const photo = async () => {
        if (attachments.length) await r.call('orchestration.dispatchCommand', {
          type: 'message.dispatch', commandId: randomUUID(), createdBy: 'user', creationSource: 'mcp',
          threadId, messageId: randomUUID(), text, attachments,
          dispatchMode: shell?.activeRunId ? { type: 'queue_after_active' } : { type: 'start_immediately' },
        })
      }
      const base = { type: 'runtime-request.respond', commandId: randomUUID(), threadId, requestId: req.id }
      if (req.kind === 'user_input') {
        const p = await r.call('orchestration.getThreadProjection', { threadId })
        const q = questionsOf(p, req.id)
        if (!q.length) return false
        await photo()
        // One answer for each question it asked; the app has one text box.
        await r.call('orchestration.dispatchCommand', { ...base, answers: Object.fromEntries(q.map(x => [x.id, text])) })
      } else {
        await photo()
        await r.call('orchestration.dispatchCommand', { ...base, decision: /^(approve|accept|allow|yes|ok)/i.test(text.trim()) ? 'accept' : 'decline' })
      }
      return true
    })
  }

  async interrupt(threadId: string): Promise<void> {
    await this.rpc(async r => {
      const shell = (await this.shells(r)).threads.find(t => t.id === threadId)
      if (!shell?.activeRunId) return
      await r.call('orchestration.dispatchCommand', { type: 'run.interrupt', commandId: randomUUID(), threadId, runId: shell.activeRunId, reason: 'stopped from Otto' })
    })
  }
}

function failureText(cause: unknown): string {
  const s = JSON.stringify(cause ?? 'failed')
  return (/"message":"([^"]{1,200})"/.exec(s)?.[1] ?? s).slice(0, 200)
}

function pickModel(model: string | undefined, project: Shell | undefined, mine: Shell[], all: Shell[]): { instanceId: string; model: string; options?: { id: string; value: string }[] } | undefined {
  if (model === 'fable') model = 'claude-fable-5-2'
  if (model === 'opus') model = 'claude-opus-5-5'
  const newest = (ts: Shell[]) => [...ts].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  if (!model) {
    const d = project?.defaultModelSelection ?? newest(mine)[0]?.modelSelection ?? newest(all)[0]?.modelSelection
    return d?.model ? { instanceId: d.instanceId, model: d.model } : undefined
  }
  // The instance that last ran this model; otherwise the provider its name implies.
  const used = newest(all).find(t => t.modelSelection?.model === model)?.modelSelection?.instanceId
  return { instanceId: used ?? (/^(claude|opus|fable|sonnet|haiku)/i.test(model) ? 'claudeAgent' : 'codex'), model }
}

export function effortOptions(selection: { instanceId: string; model: string }, effort: Effort, providers: Shell[]): { id: string; value: string }[] {
  const provider = providers.find(p => p.instanceId === selection.instanceId)
  const id = provider?.driver === 'claudeAgent' ? 'effort' : provider?.driver === 'codex' ? 'reasoningEffort' : undefined
  const descriptor = id && provider?.models?.find((m: Shell) => m.slug === selection.model || m.aliases?.includes(selection.model))?.capabilities?.optionDescriptors?.find((d: Shell) => d.id === id)
  const accepted = descriptor?.options?.map((o: Shell) => o.id) ?? []
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort) || !accepted.includes(effort)) {
    throw new Error(`Effort "${effort}" is not supported by ${selection.model} (${selection.instanceId}); accepted: ${accepted.join(', ') || 'none advertised by T3'}`)
  }
  return [{ id: descriptor.id, value: effort }]
}

type Question = { id: string; question: string; options: { label: string }[] }
function questionsOf(p: any, requestId: string): Question[] {
  const item = (p?.turnItems ?? []).findLast((i: any) => i.type === 'user_input_request' && i.requestId === requestId)
  return item?.questions ?? []
}

const RUNNING = new Set(['preparing', 'queued', 'starting', 'running', 'waiting'])

/** A thread shell (and, when we have it, its projection) as codejobs.ts reads it. */
export function snapFrom(shell: Shell, p: any): ThreadSnap {
  const req = shell.pendingRuntimeRequest
  const raw = shell.activityRunStatus ?? shell.status
  const status: ThreadSnap['status'] = req ? 'input'
    : RUNNING.has(raw) ? 'running'
      : shell.status === 'failed' ? 'error' : 'idle'
  let question: ThreadSnap['question']
  if (req) {
    const qs = req.kind === 'user_input' ? questionsOf(p, req.id) : []
    question = qs.length
      ? { text: qs.map(q => q.question).join('\n\n'), answers: qs.length === 1 ? qs[0]!.options.map(o => o.label) : qs.flatMap(q => q.options.map(o => `${q.question}: ${o.label}`)), askedAt: req.createdAt }
      : { text: req.kind === 'user_input' ? 'It asked you something in T3 Code.' : `It wants approval to run a ${String(req.kind).replace(/_/g, ' ')}.`,
          answers: req.kind === 'user_input' ? [] : ['Approve', 'Decline'], askedAt: req.createdAt }
  }
  const pending = shell.pendingBackgroundTasks
  const backgroundWork = Array.isArray(pending) && pending.length
    ? `Waiting on ${String(pending[0].description || pending[0].kind || 'background work').replace(/^waiting (?:on|for)\s+/i, '').slice(0, 109)}` : undefined
  const running = (p?.turnItems ?? []).findLast((i: any) => i.status === 'running' && i.title)
  const said = (p?.messages ?? []).findLast((m: any) => m.role === 'assistant' && m.text)
  // ponytail: tokens are each provider turn's context at its end, summed; T3 keeps no billed total per thread.
  const tokens = (p?.providerTurns ?? []).reduce((n: number, t: any) => n + (t.tokenUsage?.usedTokens ?? 0), 0)
  // A link alone does not mean the thread opened the PR (review/merge threads link others).
  const prs = [...[...(shell.pullRequests ?? [])].reverse(), shell.linkedPullRequest]
    .filter((x: any) => x && x.source !== 'stack-dismissed' && (x.host ?? 'github.com') === 'github.com' && /^[\w.-]+\/[\w.-]+$/.test(String(x.repository)) && Number(x.number) > 0)
    .map((x: any) => ({ repo: String(x.repository), n: Number(x.number), ...(x.source === 'created' ? { openedByThread: true } : {}) }))
  const pr = prs[0]
  const latestRun = p?.runs?.reduce((latest: any, run: any) => !latest || run.ordinal > latest.ordinal ? run : latest, undefined)
  return {
    id: shell.id, status,
    ...(typeof raw === 'string' && raw ? { t3Status: raw } : {}),
    runRequestedAt: latestRun?.requestedAt ?? shell.runRequestedAt,
    ...(req && RUNNING.has(raw) ? { activeTurn: true } : {}),
    ...(backgroundWork ? { backgroundWork } : {}),
    ...(running ? { now: String(running.title).slice(0, 120) } : {}),
    ...(question ? { question } : {}),
    ...(tokens ? { tokensUsed: tokens } : {}),
    ...(shell.modelSelection?.model ? { model: modelLabel(shell.modelSelection.model, shell.modelSelection.options?.find((o: Shell) => o.id === 'effort' || o.id === 'reasoningEffort')?.value) } : {}),
    ...(shell.branch ? { branch: shell.branch } : {}),
    ...(said ? { lastMessage: String(said.text) } : shell.latestVisibleMessage?.text ? { lastMessage: String(shell.latestVisibleMessage.text) } : {}),
    ...(shell.updatedAt ? { updatedAt: shell.updatedAt } : {}),
    ...(pr ? { pr, prs } : {}),
    ...(shell.worktreePath ? { worktreePath: String(shell.worktreePath) } : {}),
  }
}

/** Its own token, read-only: the usage scan wants diagnostics:read, which the jobs token has no need for. */
export const t3UsageClient = (): T3Client => new T3Client({
  tokenFile: join(STATE_DIR, 't3-usage-token'),
  mint: () => mintWithCli(['orchestration:read', 'diagnostics:read'], 'otto usage'),
})
