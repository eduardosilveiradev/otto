import { test, expect } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Boards, columnFor, haiku, projectContext, type Board } from '../boards.ts'
import type { WireJob } from '../codejobs.ts'

const wire = (id: string, state: WireJob['state']) => ({ id, state }) as WireJob

function setup() {
  const file = join(mkdtempSync(join(tmpdir(), 'boards-')), 'boards.json')
  const started: { project: string; title: string; brief: string }[] = []
  const live = new Map<string, WireJob>()
  const pushed: Board[][] = []
  const boards = new Boards({
    file, push: b => pushed.push(b),
    jobs: {
      projects: async () => [{ name: 'demo' }, { name: 'other' }],
      start: async input => {
        await Bun.sleep(5)
        started.push(input)
        const j = wire(`j${started.length}`, 'running')
        live.set(j.id, j)
        return j
      },
      job: async id => live.get(id),
    },
  })
  return { boards, started, live, pushed, file }
}

const titles = (b: Boards, col: string) => b.boards().then(bs => bs.find(x => x.project === 'demo')!.cards.filter(c => c.column === col).map(c => c.title))

test('card CRUD and ordering', async () => {
  const { boards, pushed } = setup()
  expect((await boards.boards()).map(b => b.project)).toEqual(['demo', 'other'])
  const a = boards.upsert({ project: 'demo', title: 'a' })
  const b = boards.upsert({ project: 'demo', title: 'b', notes: 'why' })
  const c = boards.upsert({ project: 'demo', title: 'c' })
  expect(await titles(boards, 'backlog')).toEqual(['a', 'b', 'c'])
  expect(b.notes).toBe('why')
  boards.upsert({ project: 'demo', id: c.id, order: 0 })
  expect(await titles(boards, 'backlog')).toEqual(['c', 'a', 'b'])
  boards.upsert({ project: 'demo', id: a.id, column: 'review', title: 'a2' })
  expect(await titles(boards, 'review')).toEqual(['a2'])
  expect((await boards.boards())[0]!.cards.filter(x => x.column === 'backlog').map(x => x.order)).toEqual([0, 1])
  boards.remove('demo', c.id)
  expect(await titles(boards, 'backlog')).toEqual(['b'])
  expect(() => boards.upsert({ project: 'demo', id: 'nope', title: 'x' })).toThrow('no such card')
  expect(() => boards.upsert({ project: 'demo', id: b.id, column: 'later' })).toThrow('column must be')
  expect(() => boards.upsert({ project: 'demo' })).toThrow('title is required')
  expect(pushed.length).toBe(6)
})

test('routes answer in JSON', async () => {
  const { boards } = setup()
  const post = (path: string, body: unknown) => boards.handle(new Request(`http://x${path}`, { method: 'POST', body: JSON.stringify(body) }), path)
  const { card } = await (await post('/app/boards/card', { project: 'demo', title: 't' })).json() as { card: { id: string } }
  const got = await (await boards.handle(new Request('http://x/app/boards'), '/app/boards')).json() as { boards: Board[] }
  expect(got.boards[0]!.cards[0]!.id).toBe(card.id)
  expect((await post('/app/boards/delete', { project: 'demo', id: card.id })).status).toBe(200)
  expect((await post('/app/boards/delete', { project: 'demo', id: card.id })).status).toBe(404)
  expect((await post('/app/boards/nope', {})).status).toBe(404)
})

test('start is idempotent per card and uses title and notes as the brief', async () => {
  const { boards, started, live } = setup()
  const card = boards.upsert({ project: 'demo', title: 'Add dark mode', notes: 'settings screen' })
  // No default model: a start without one is refused before any job exists.
  await expect(boards.start({ project: 'demo', cardId: card.id })).rejects.toThrow('pick a model')
  const m = { model: 'claude-opus-5-5', effort: 'high' }
  const [one, two] = await Promise.all([boards.start({ project: 'demo', cardId: card.id, ...m }), boards.start({ project: 'demo', cardId: card.id, ...m })])
  const three = await boards.start({ project: 'demo', cardId: card.id, ...m })
  expect(started).toEqual([{ project: 'demo', title: 'Add dark mode', brief: 'Add dark mode\n\nsettings screen', origin: 'user-typed', model: 'claude-opus-5-5', effort: 'high' } as never])
  expect([one.id, two.id, three.id]).toEqual(['j1', 'j1', 'j1'])
  const stored = (await boards.boards())[0]!.cards[0]!
  expect([stored.jobId, stored.column]).toEqual(['j1', 'progress'])
  // Dragged back to backlog while the job runs: still that job.
  boards.upsert({ project: 'demo', id: card.id, column: 'backlog' })
  expect((await boards.start({ project: 'demo', cardId: card.id, model: 'claude-opus-5-5' })).id).toBe('j1')
  // A failed job sends the card back; starting again makes a new job.
  live.set('j1', wire('j1', 'failed'))
  boards.follow([wire('j1', 'failed')])
  expect((await boards.start({ project: 'demo', cardId: card.id, brief: 'try again', model: 'gpt-6.1-sol' })).id).toBe('j2')
  expect(started[1]!.brief).toBe('try again')
})

test('column follows the job', async () => {
  const { boards, pushed } = setup()
  const card = boards.upsert({ project: 'demo', title: 'x' })
  await boards.start({ project: 'demo', cardId: card.id, model: 'claude-opus-5-5' })
  const col = async () => (await boards.boards())[0]!.cards[0]!
  const cases: [WireJob['state'], string][] = [['running', 'progress'], ['input', 'progress'], ['waiting', 'progress'], ['queued', 'progress'],
    ['review', 'review'], ['done', 'review'], ['merged', 'done'], ['stopped', 'backlog'], ['failed', 'backlog']]
  for (const [state, column] of cases) {
    expect(columnFor(state)).toBe(column as never)
    boards.follow([wire('j1', state)])
    expect((await col()).column).toBe(column as never)
  }
  expect((await col()).jobId).toBe('j1')
  const n = pushed.length
  boards.follow([wire('j1', 'failed'), wire('other', 'merged')])
  expect(pushed.length).toBe(n)
  // A card dragged off its job's column stays until the job changes.
  boards.upsert({ project: 'demo', id: card.id, column: 'done' })
  boards.follow([wire('j1', 'failed')])
  expect((await col()).column).toBe('done')
})

test('rewrite: card and project docs reach the model, the draft comes back unsaved', async () => {
  const root = mkdtempSync(join(tmpdir(), 'boards-root-'))
  writeFileSync(join(root, 'README.md'), 'Demo is a notes app for the Mac.')
  const asked: string[] = []
  const pushed: Board[][] = []
  const boards = new Boards({
    file: join(mkdtempSync(join(tmpdir(), 'boards-')), 'boards.json'), push: b => pushed.push(b),
    jobs: { projects: async () => [{ name: 'demo', root }], start: async () => { throw new Error('no') }, job: async () => undefined },
    ask: async (system, user) => { asked.push(system, user); return '```\nAdd dark mode to settings\n\nGoal:\n- Settings follows the system appearance\n```' },
  })
  const card = boards.upsert({ project: 'demo', title: 'dark mode', notes: 'settings screen' })
  pushed.length = 0
  const res = await boards.handle(new Request('http://x/app/boards/rewrite', { method: 'POST', body: JSON.stringify({ project: 'demo', id: card.id }) }), '/app/boards/rewrite')
  expect(res.status).toBe(200)
  expect(await res.json()).toEqual({ title: 'Add dark mode to settings', notes: 'Goal:\n- Settings follows the system appearance' })
  expect(asked[0]).toContain('Add no new requirements')
  expect(asked[1]).toContain('Demo is a notes app for the Mac.')
  expect(asked[1]).toContain('Card title: dark mode')
  expect(asked[1]).toContain('settings screen')
  expect(pushed).toEqual([])
  expect((await boards.boards())[0]!.cards[0]).toMatchObject({ title: 'dark mode', notes: 'settings screen' })

  const missing = await boards.handle(new Request('http://x/app/boards/rewrite', { method: 'POST', body: JSON.stringify({ project: 'demo', id: 'nope' }) }), '/app/boards/rewrite')
  expect(missing.status).toBe(404)
})

test('rewrite: no key is 503, a failed or empty model answer is 502', async () => {
  const { boards, file } = setup()
  const card = boards.upsert({ project: 'demo', title: 'x' })
  const body = JSON.stringify({ project: 'demo', id: card.id })
  const call = (b: Boards) => b.handle(new Request('http://x/app/boards/rewrite', { method: 'POST', body }), '/app/boards/rewrite')
  const jobs = { projects: async () => [], start: async () => { throw new Error('no') }, job: async () => undefined }
  expect((await call(new Boards({ file, jobs, ask: haiku(() => undefined) }))).status).toBe(503)
  expect((await call(new Boards({ file, jobs, ask: async () => { throw new Error('timeout') } }))).status).toBe(502)
  expect((await call(new Boards({ file, jobs, ask: async () => '  ' }))).status).toBe(502)
})

test('rewrite context: a project on the T3 machine is read over ssh, never as a local path', async () => {
  const cmds: string[][] = []
  const exec = async (cmd: string[], cwd?: string) => {
    cmds.push(cwd ? [`cwd=${cwd}`, ...cmd] : cmd)
    const remote = cmd.join(' ')
    if (remote.includes('README.md')) return '# Demo bridge'
    if (remote.includes('ls-files')) return 'src/app.ts\nsidecar.py'
    return undefined
  }
  const ctx = await projectContext('/work/proj', 'mac', exec)
  expect(ctx).toContain('# Demo bridge')
  expect(ctx).toContain('src/app.ts')
  expect(cmds.every(c => c[0] === 'ssh' && c.includes('mac'))).toBe(true)
  expect(cmds.some(c => /-C.*\/work\/proj.*ls-files/.test(c.at(-1)!))).toBe(true)
})

test('a long rant of a title is kept whole for the rewrite', () => {
  const { boards } = setup()
  const rant = 'the quick add closes when '.repeat(40).trim()
  const card = boards.upsert({ project: 'demo', title: rant })
  expect(card.title).toBe(rant)
})

const archive = (b: Boards, path: string, body: unknown) => b.handle(new Request(`http://x/app/boards/${path}`, { method: 'POST', body: JSON.stringify(body) }), `/app/boards/${path}`)
const demoCards = async (res: Response) => ((await res.json()) as { boards: Board[] }).boards.find(x => x.project === 'demo')!.cards

test('archive with no ids takes only the done cards, and GET still lists them', async () => {
  const { boards, pushed } = setup()
  const a = boards.upsert({ project: 'demo', title: 'a', column: 'done' })
  const b = boards.upsert({ project: 'demo', title: 'b', column: 'done' })
  const c = boards.upsert({ project: 'demo', title: 'c', column: 'review' })
  const n = pushed.length
  const res = await archive(boards, 'archive', { project: 'demo' })
  expect(res.status).toBe(200)
  const cards = await demoCards(res)
  expect(cards.filter(x => x.archivedAt).map(x => x.id).sort()).toEqual([a.id, b.id].sort())
  expect(cards.find(x => x.id === c.id)!.archivedAt).toBeUndefined()
  expect(pushed.length).toBe(n + 1)
  const got = await demoCards(await boards.handle(new Request('http://x/app/boards'), '/app/boards'))
  expect(got.filter(x => x.archivedAt).length).toBe(2)
  // Again: nothing new to archive, so no write and the first timestamp stays.
  const first = cards.find(x => x.id === a.id)!.archivedAt
  await archive(boards, 'archive', { project: 'demo' })
  expect(pushed.length).toBe(n + 1)
  expect((await demoCards(await archive(boards, 'archive', { project: 'demo' }))).find(x => x.id === a.id)!.archivedAt).toBe(first)
})

test('archive and unarchive by ids', async () => {
  const { boards } = setup()
  const a = boards.upsert({ project: 'demo', title: 'a', column: 'done' })
  const b = boards.upsert({ project: 'demo', title: 'b', column: 'done' })
  const c = boards.upsert({ project: 'demo', title: 'c' })
  const archived = async (res: Response) => (await demoCards(res)).filter(x => x.archivedAt).map(x => x.id)
  expect(await archived(await archive(boards, 'archive', { project: 'demo', ids: [a.id] }))).toEqual([a.id])
  expect(await archived(await archive(boards, 'archive', { project: 'demo', ids: [] }))).toEqual([a.id])
  expect(await archived(await archive(boards, 'unarchive', { project: 'demo', ids: [a.id] }))).toEqual([])
  // A bad batch writes nothing.
  const refused = await archive(boards, 'archive', { project: 'demo', ids: [b.id, c.id] })
  expect(refused.status).toBe(409)
  expect(((await refused.json()) as { error: string }).error).toBe(`card ${c.id} is in backlog, not done: only done cards can be archived`)
  expect((await archive(boards, 'archive', { project: 'demo', ids: [b.id, 'nope'] })).status).toBe(404)
  expect(await archived(await archive(boards, 'unarchive', { project: 'demo', ids: [] }))).toEqual([])
  expect((await archive(boards, 'unarchive', { project: 'demo' })).status).toBe(400)
  expect((await archive(boards, 'archive', { project: 'demo', ids: 'x' })).status).toBe(400)
  expect((await archive(boards, 'archive', { ids: [b.id] })).status).toBe(400)
  expect((await boards.handle(new Request('http://x/app/boards/archive'), '/app/boards/archive')).status).toBe(405)
})

test('archiving one done card leaves the rest of done alone', async () => {
  const { boards, pushed } = setup()
  const a = boards.upsert({ project: 'demo', title: 'a', column: 'done' })
  const b = boards.upsert({ project: 'demo', title: 'b', column: 'done' })
  const n = pushed.length
  const res = await archive(boards, 'archive', { project: 'demo', ids: [b.id] })
  expect(res.status).toBe(200)
  const cards = await demoCards(res)
  expect(cards.find(x => x.id === b.id)!.archivedAt).toBeString()
  expect(cards.find(x => x.id === a.id)!.archivedAt).toBeUndefined()
  expect(cards.map(x => x.column)).toEqual(['done', 'done'])
  expect(pushed.length).toBe(n + 1)
})

test('leaving done clears archivedAt, by drag or by the job reopening', async () => {
  const { boards } = setup()
  const dragged = boards.upsert({ project: 'demo', title: 'dragged', column: 'done' })
  const card = boards.upsert({ project: 'demo', title: 'job' })
  await boards.start({ project: 'demo', cardId: card.id, model: 'claude-opus-5-5' })
  boards.follow([wire('j1', 'merged')])
  await archive(boards, 'archive', { project: 'demo' })
  const get = async (id: string) => (await boards.boards())[0]!.cards.find(x => x.id === id)!
  expect((await get(card.id)).archivedAt).toBeString()
  // Reordering inside done keeps it.
  boards.upsert({ project: 'demo', id: dragged.id, order: 0 })
  expect((await get(dragged.id)).archivedAt).toBeString()
  boards.upsert({ project: 'demo', id: dragged.id, column: 'review' })
  expect((await get(dragged.id)).archivedAt).toBeUndefined()
  boards.follow([wire('j1', 'running')])
  expect(await get(card.id)).toMatchObject({ column: 'progress' })
  expect((await get(card.id)).archivedAt).toBeUndefined()
})

test('a boards.json written before archivedAt still loads', async () => {
  const { boards, file } = setup()
  writeFileSync(file, JSON.stringify({ demo: [{ id: 'c1', title: 'old', notes: '', column: 'done', createdAt: '2026-01-01T00:00:00.000Z', order: 0 }] }))
  expect((await boards.boards())[0]!.cards[0]).toMatchObject({ id: 'c1', title: 'old', column: 'done' })
  const cards = await demoCards(await archive(boards, 'archive', { project: 'demo' }))
  expect(cards[0]!.archivedAt).toBeString()
})
