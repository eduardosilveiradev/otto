import { test, expect } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { JobEvents, JOB_COALESCE_MS } from '../jobevents.ts'
import { wireJob, type CodeJob, type WireJob } from '../codejobs.ts'

test('attention transitions persist, retry durable acceptance, coalesce flaps and suppress explicit stops', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-events-'))
  try {
    let now = 1000, accepted = true
    const events: { id: string; content: string; meta: Record<string, string> }[] = []
    const deps = { file: join(dir, 'events.json'), now: () => now,
      injectEvent: async (event: string, content: string, meta: Record<string, string>, id: string) => {
        expect(event).toBe('job')
        if (accepted) events.push({ id, content, meta })
        return accepted
      } }
    const record: CodeJob = { id: 'j1', title: 'Fix', project: 'demo', repo: 'example/demo', branch: 'fix', brief: '', agent: 'T3 Code', where: 'local', threadId: 't1', createdAt: new Date(0).toISOString(), tokenBudget: 100, steps: [] }
    let watcher = new JobEvents(deps)
    const base = wireJob(record, { id: 't1', status: 'running' }, undefined)
    const observe = (over: Partial<WireJob>) => watcher.observe([{ ...base, ...over }], [record])
    await observe({})
    const question = { text: 'Full question\n' + 'x'.repeat(1000), answers: ['one', 'two'], askedAt: 'now' }
    accepted = false
    await observe({ state: 'input', question })
    expect(events).toHaveLength(0)
    accepted = true
    await observe({ state: 'input', question })
    expect(JSON.parse(events[0]!.content.split('\n').slice(1).join('\n')).question).toEqual(question)
    expect(events[0]!.meta).toMatchObject({ job: 'j1', branch: 'fix', repo: 'example/demo', state: 'input' })
    watcher = new JobEvents(deps)
    await observe({ state: 'input', question })
    await observe({})
    await observe({ state: 'input', question })
    expect(events).toHaveLength(1)
    now += JOB_COALESCE_MS
    await observe({})
    await observe({ state: 'input', question })
    expect(events).toHaveLength(2)
    await observe({ state: 'input', question: { ...question, text: 'Next question' } })
    const pr: NonNullable<WireJob['pr']> = { n: 7, title: 'PR title', mergeable: 'CONFLICTING', url: 'https://github.com/example/demo/pull/7', add: 1, del: 0, files: 1, base: 'main', checks: '', draft: false, diff: [] }
    await observe({ state: 'review', pr })
    expect(events.at(-1)!.meta).toMatchObject({ pr: '7', pr_title: 'PR title', mergeable: 'CONFLICTING' })
    await observe({ state: 'stopped', pr })
    expect(events).toHaveLength(4)
    await observe({ state: 'failed', now: 'Last failure' })
    expect(events.at(-1)!.content).toContain('Last failure')
    record.stoppedAt = new Date(now).toISOString()
    record.steps.push({ ts: record.stoppedAt, text: 'Stopped' })
    await observe({ state: 'stopped' })
    expect(events).toHaveLength(5)
    delete record.stoppedAt
    await observe({})
    await observe({ state: 'stopped' })
    expect(events).toHaveLength(6)
    expect(new Set(events.map(e => e.id)).size).toBe(events.length)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('journal acceptance survives transport failure and a crash before the transition save', async () => {
  const { journalMergeDelivery } = await import('../prmerges.ts')
  const { loadJournal, saveJournal, recordInbound, takeRedeliveries, markRead } = await import('../redeliver.ts')
  const { writeFileSync, readFileSync } = await import('fs')
  const dir = mkdtempSync(join(tmpdir(), 'job-journal-'))
  try {
    const file = join(dir, 'events.json'), journal = join(dir, 'journal.json')
    const start = Date.parse('2026-11-01T00:00:00Z')
    let sends = 0
    const injectEvent = journalMergeDelivery(journal, async (event, text, meta, id) => {
      sends++
      saveJournal(journal, recordInbound(loadJournal(journal), { chat_id: event, message_id: id, text, meta: { ...meta, event }, read: false }, start))
      return false
    })
    const j = { id: 'j1', state: 'running', title: 'Fix', project: 'demo', branch: 'fix', pr: null, question: null, steps: [] } as unknown as WireJob
    await new JobEvents({ file, injectEvent }).observe([j], [])
    const before = readFileSync(file, 'utf8')
    await new JobEvents({ file, injectEvent }).observe([{ ...j, state: 'input', question: { text: 'Which?', answers: ['A'], askedAt: 'now' } }], [])
    writeFileSync(file, before)
    await new JobEvents({ file, injectEvent }).observe([{ ...j, state: 'input', question: { text: 'Which?', answers: ['A'], askedAt: 'now' } }], [])
    expect(sends).toBe(1)
    const pending = loadJournal(journal)
    const options = { now: start + 12 * 3_600_000, bootAt: start + 12 * 3_600_000, windowMs: 0 }
    expect(takeRedeliveries(pending, options)).toHaveLength(1)
    markRead(pending, [pending[0]!.message_id])
    expect(takeRedeliveries(pending, options)).toHaveLength(0)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('a job that ends without a PR raises one event, and one with a PR raises none', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'job-events-'))
  try {
    const events: Record<string, string>[] = []
    const watcher = new JobEvents({ file: join(dir, 'events.json'), injectEvent: async (_e: string, _c: string, meta: Record<string, string>) => { events.push(meta); return true } })
    const record = { id: 'j1', title: 'Fix', project: 'demo', branch: 'fix', brief: '', agent: 'T3 Code', where: 'local', threadId: 't1', createdAt: new Date(0).toISOString(), startedAt: new Date(0).toISOString(), steps: [] } as unknown as CodeJob
    const base = wireJob(record, { id: 't1', status: 'running' }, undefined)
    const endedAt = new Date().toISOString()
    await watcher.observe([{ ...base, state: 'done', endedAt }], [record])
    await watcher.observe([{ ...base, state: 'done', endedAt }], [record])
    await watcher.observe([{ ...base, id: 'j2', state: 'done', endedAt, pr: { n: 1 } as WireJob['pr'] }], [record])
    await watcher.observe([{ ...base, id: 'j3', state: 'done', endedAt: new Date(Date.now() - 86_400_000).toISOString() }], [record])
    expect(events.map(m => [m.job, m.state])).toEqual([['j1', 'done']])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('non-host observation cannot claim transitions or emit, even before host promotion', async () => {
  const { readFileSync, writeFileSync } = await import('fs')
  const dir = mkdtempSync(join(tmpdir(), 'job-host-'))
  try {
    const file = join(dir, 'job-events.json')
    const before = '{"jobs":{}}\n'
    writeFileSync(file, before)
    let host = false, emitted = 0
    const watcher = new JobEvents({ file, isHost: () => host,
      injectEvent: async () => { emitted++; return true } })
    const j = { id: 'j1', state: 'review', title: 'Fix', project: 'demo', branch: 'fix', pr: { n: 7 }, question: null, steps: [] } as unknown as WireJob
    await watcher.observe([{ ...j, state: 'running', pr: null }], [])
    await watcher.observe([j], [])
    expect(emitted).toBe(0)
    expect(readFileSync(file, 'utf8')).toBe(before)
    host = true
    await watcher.observe([j], [])
    expect(emitted).toBe(1)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
