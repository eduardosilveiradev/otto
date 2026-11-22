import { test, expect } from 'bun:test'
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startTwin, waitFor, phone } from './apptwin.ts'
import { startFakeT3 } from './faket3.ts'
import { recordInbound } from '../redeliver.ts'

const text = (r: any) => String(r?.content?.[0]?.text ?? JSON.stringify(r))
for (const event of ['job', 'email-scan', 'webhook']) {
  test(`overnight server admission from ${event}`, async () => {
    const fake = startFakeT3(), bin = mkdtempSync(join(tmpdir(), 'overnight-gh-'))
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\necho "[]"\n'); chmodSync(join(bin, 'gh'), 0o755)
    fake.projects.push({ id: 'demo', title: 'demo' })
    let t = await startTwin(undefined, { OTTO_T3_URL: fake.url, PATH: `${bin}:${process.env.PATH}` })
    try {
      const until = new Date(Date.now() + 3600_000).toISOString()
      expect(text(await t.call('overnight', { action: 'start', until }))).toContain('"active":true')
      expect(text(await t.call('create_trigger', { type: 'cron', schedule: new Date(Date.now() + 7200_000).toISOString(), action: 'Check test status', allow_quiet_hours: true }))).toContain('created trigger')
      expect(text(await t.call('overnight', { action: 'status' }))).toContain('"actions":0')
      await t.stop()
      writeFileSync(join(t.state, 't3-token'), fake.token)
      writeFileSync(join(t.state, 'inbound-journal.json'), JSON.stringify(recordInbound([], {
        chat_id: 'app', message_id: 'overnight-event', text: 'Work update', meta: { event }, read: false,
      }, Date.now())))
      t = await t.restart()
      expect(await waitFor(() => t.delivered.some(d => d.meta.event === event))).toBe(true)
      for (const action of ['start', 'stop']) expect((await t.call('overnight', { action, until }) as any).isError).toBe(true)
      const job = text(await t.call('code_job', { project: 'demo', title: 'Repair parser', brief: 'Repair parsing', model: 'gpt-6.1-sol' }))
      const reload = text(await t.call('reload', {}))
      if (event === 'job') {
        expect(job).toContain('started in T3 Code'); expect(fake.launches).toHaveLength(1)
        expect(reload).toContain('not running under the supervisor')
        expect(text(await t.call('overnight', { action: 'status' }))).toContain('"actions":1')
        const log = () => JSON.parse(readFileSync(join(t.state, 'capability-log.json'), 'utf8')) as any[]
        expect(log()[0]).toMatchObject({ origin: 'triggered', tier: 'unattended', what: 'overnight code_job' })
        expect((await t.call('code_job', { project: 'missing', title: 'Fail', brief: 'Fail' }) as any).isError).toBe(true)
        expect(log()).toHaveLength(1)
        const created = text(await t.call('create_trigger', { type: 'cron', schedule: new Date(Date.now() + 7200_000).toISOString(), action: 'Check unattended status', allow_quiet_hours: true }))
        const id = created.match(/created trigger ([a-z0-9]+)/)![1]
        expect(log().at(-1)).toMatchObject({ origin: 'triggered', tier: 'confirmed', revert: { kind: 'delete-trigger', triggerId: id } })
        await t.call('update_trigger', { id, action: 'Check revised status' })
        expect(log().at(-1)).toMatchObject({ tier: 'unattended', paths: [`trigger:${id}/action`], revert: { kind: 'restore-trigger', trigger: { id, action: 'Check unattended status' } } })
        await t.call('delete_trigger', { id })
        expect(log().at(-1)).toMatchObject({ tier: 'confirmed', revert: { kind: 'restore-trigger', trigger: { id, action: 'Check revised status' } } })
        expect(log()).toHaveLength(4)

      } else {
        expect(job).toContain('not starting it'); expect(fake.launches).toHaveLength(0)
        expect(reload).toContain('not reloading'); expect(reload).toContain('external-content')
      }
    } finally { await t.stop(); fake.stop() }
  }, 20000)
}

for (const armed of [false, true]) {
  test(`loadOrigin restores the unattended stamp; ask_approval window ${armed ? 'on' : 'off'}`, async () => {
    let t = await startTwin()
    let p: Awaited<ReturnType<typeof phone>> | undefined
    try {
      let windowId: string | undefined
      if (armed) windowId = JSON.parse(text(await t.call('overnight', { action: 'start', until: new Date(Date.now() + 3600_000).toISOString() }))).id
      await t.stop()
      writeFileSync(join(t.state, 'origin.json'), JSON.stringify({ origin: 'triggered', internalEvent: 'job', tainted: false, turnOpen: false }))
      t = await t.restart()
      const request = { title: 'Core change', summary: 'Review this proposed core change.', paths: ['otto/server.ts'] }
      if (armed) {
        expect((await t.call('ask_approval', request) as any).isError).toBe(true)
        expect(text(await t.call('overnight', { action: 'status' }))).toContain('"actions":0')
      }
      p = await phone(t)
      const check = (path = 'otto/server.ts') => t.call('self_edit_check', { paths: [path] }).then(text)
      expect(await check()).toContain('this request: triggered')
      expect(await check()).toContain('allowed now: no')
      const result = text(await t.call('ask_approval', request))
      if (!armed) {
        expect(result).toContain('no approval can clear this turn')
        expect(p.got.filter(f => f.type === 'approval')).toHaveLength(0)
        // These gates were already open on an unattended turn, without a window.
        expect(text(await t.call('reload', {}))).toContain('not running under the supervisor')
        expect(text(await t.call('create_trigger', { type: 'cron', schedule: new Date(Date.now() + 7200_000).toISOString(), action: 'Check baseline status', allow_quiet_hours: true }))).toContain('created trigger')
      } else {
        expect(result).toContain('approval screen is up')
        const card = await p.until(f => f.type === 'approval')
        expect(card).toMatchObject({ windowId, files: [{ path: 'otto/server.ts', tier: 'guarded' }] })
        expect(card.summary).toContain('Raised by an unattended update')
        expect(card.summary).toContain(windowId!)
        expect(await check()).toContain('allowed now: no')
        p.send({ type: 'approval', id: card.id, op: 'approve-overnight-core', decision: 'approve' })
        expect(await p.until(f => f.type === 'approval_done' && f.id === card.id)).toBeTruthy()
        expect(await check()).toContain('allowed now: yes')
        expect(await check('otto/selfedit.ts')).toContain('allowed now: no')
        const entries = JSON.parse(readFileSync(join(t.state, 'capability-log.json'), 'utf8'))
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({ windowId, origin: 'triggered', tier: 'guarded', paths: ['otto/server.ts'], what: 'overnight ask_approval' })
        await t.call('ask_approval', { ...request, title: 'Owner change' })
        const ownerCard = await p.until(f => f.type === 'approval' && f.id !== card.id)
        expect(ownerCard.windowId).toBeUndefined()
        expect(ownerCard.summary).toBe(request.summary)
        expect(JSON.parse(readFileSync(join(t.state, 'capability-log.json'), 'utf8'))).toHaveLength(1)
      }
    } finally { p?.close(); await t.stop() }
  }, 20000)
}
