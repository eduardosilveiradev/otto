/**
 * A fake T3 Code server: the slice of its Effect RPC websocket (/ws?orchestrationProtocol=2)
 * that t3.ts speaks. Threads and projects are plain objects the test edits; every command it
 * was sent is kept in `commands`.
 */
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export type FakeT3 = {
  url: string
  token: string
  projects: Record<string, unknown>[]
  threads: Record<string, any>[]
  projections: Record<string, any>
  commands: any[]
  launches: any[]
  /** server.getConfig's providers, and server.getUsageSummary's answer (an Error fails it). */
  providers: any[]
  summary: any
  /** A method that drops the socket instead of answering, like T3 restarting mid-call. */
  closeOn?: string
  stop: () => void
}

export function startFakeT3(token = 'fake-t3-token'): FakeT3 {
  const t3: Omit<FakeT3, 'url' | 'stop'> = { token, projects: [], threads: [], projections: {}, commands: [], launches: [], providers: [], summary: new Error('no summary') }
  const server = Bun.serve({
    port: 0,
    fetch(req, srv) {
      const url = new URL(req.url)
      if (url.pathname !== '/ws') return new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } })
      if (url.searchParams.get('orchestrationProtocol') !== '2') return new Response(null, { status: 426 })
      if (req.headers.get('authorization') !== `Bearer ${t3.token}`) return new Response(null, { status: 401 })
      return srv.upgrade(req) ? undefined : new Response(null, { status: 400 })
    },
    websocket: {
      message(ws, raw) {
        const m = JSON.parse(String(raw))
        if (m._tag !== 'Request') return
        if (m.tag === t3.closeOn) return void ws.terminate()
        const ok = (value: unknown): void => void ws.send(JSON.stringify({ _tag: 'Exit', requestId: m.id, exit: { _tag: 'Success', value } }))
        const fail = (message: string): void => void ws.send(JSON.stringify({ _tag: 'Exit', requestId: m.id, exit: { _tag: 'Failure', cause: [{ _tag: 'Fail', error: { message } }] } }))
        switch (m.tag) {
          case 'orchestration.subscribeShell':
            return void ws.send(JSON.stringify({ _tag: 'Chunk', requestId: m.id, values: [{ kind: 'snapshot', snapshot: { projects: t3.projects, threads: t3.threads, archivedThreads: [], snapshotSequence: 1 } }] }))
          case 'orchestration.getThreadProjection': {
            const p = t3.projections[m.payload.threadId]
            return p ? ok(p) : fail('no such thread')
          }
          case 'orchestration.launchThread': {
            t3.launches.push(m.payload)
            const id = `thread-${t3.launches.length}`
            const thread = { id, projectId: m.payload.projectId, title: m.payload.title, status: 'running', activityRunStatus: 'running', activeRunId: `run-${id}`,
              branch: m.payload.workspaceStrategy.branch, modelSelection: m.payload.modelSelection, pendingRuntimeRequest: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }
            t3.threads.push(thread)
            return ok({ threadId: id, projection: { thread }, resumed: false })
          }
          case 'orchestration.dispatchCommand':
            t3.commands.push(m.payload)
            return ok({ sequence: t3.commands.length })
          case 'projects.mutate': {
            t3.commands.push(m.payload)
            const project = t3.projects.find(p => p.id === m.payload.projectId)
            if (!project) return fail('no such project')
            Object.assign(project, { workspaceRoot: m.payload.workspaceRoot })
            return ok(project)
          }
          case 'server.getConfig':
            return ok({ providers: t3.providers })
          case 'server.getUsageSummary':
            t3.commands.push({ usage: m.payload })
            return t3.summary instanceof Error ? fail(t3.summary.message) : ok(t3.summary)
          default:
            return fail(`unknown method ${m.tag}`)
        }
      },
    },
  })
  // The same object the handler reads, so a test that changes `token` or `threads` changes the server.
  return Object.assign(t3, { url: `http://127.0.0.1:${server.port}`, stop: () => { void server.stop(true) } })   // not awaited: Bun never settles it once a socket was dropped mid-request
}

/** A real checkout whose origin is a local bare repo with `main`, so a job's launch preflight never touches the network; upstream names the GitHub repo. */
export function fakeCheckout(upstream = 'https://github.com/example/demo.git'): string {
  const checkout = mkdtempSync(join(tmpdir(), 'otto-job-checkout-')), origin = mkdtempSync(join(tmpdir(), 'otto-job-origin-'))
  for (const args of [['init', '-q', '--bare', origin], ['init', '-q', '-b', 'main', checkout],
    ['-C', checkout, '-c', 'user.name=otto', '-c', 'user.email=otto@example.com', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-qm', 'init'],
    ['-C', checkout, 'remote', 'add', 'origin', origin], ['-C', checkout, 'push', '-q', 'origin', 'main'], ['-C', checkout, 'remote', 'add', 'upstream', upstream]]) {
    const result = Bun.spawnSync(['git', ...args], { stdout: 'pipe', stderr: 'pipe' })
    if (result.exitCode !== 0) throw new Error(String(result.stderr))
  }
  return checkout
}
