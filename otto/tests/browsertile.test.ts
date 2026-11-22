import { afterAll, beforeAll, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import { join } from 'path'
import { caption, cleanUrl, tabOf } from '../browsertile.ts'
import { phone, startTwin, type Twin } from './apptwin.ts'

const PNG = readFileSync(join(import.meta.dir, '..', 'assets', 'icon-1024.png')).toString('base64')
const ctx = (title: string, url: string, id = 7) =>
  ({ type: 'text', text: `\n\nTab Context:\n- Executed on tabId: ${id}\n- Available tabs:\n  • tabId 9: "Other" ("https://other.example/")\n  • tabId ${id}: "${title}" ("${url}")` })
const shot = (url: string, title = 'Example page') =>
  [{ type: 'text', text: 'Successfully captured screenshot' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG } }, ctx(title, url)]
const post = (t: Twin, tool: string, input: Record<string, unknown>, response: unknown) =>
  t.hook({ hook_event_name: 'PostToolUse', tool_name: `mcp__claude-in-chrome__${tool}`, tool_input: input, tool_response: response })

test('tab context, url and caption parsing', () => {
  expect(tabOf([ctx('Say "hi" (now)', 'https://example.com/a?b=1')])).toEqual({ id: '7', title: 'Say "hi" (now)', url: 'https://example.com/a?b=1' })
  expect(tabOf([{ type: 'text', text: 'no context' }])).toBeNull()
  expect(cleanUrl('https://example.com/a/b?token=x#y')).toBe('https://example.com/a/b')
  expect(cleanUrl('chrome://newtab/')).toBe('')
  expect(caption('example.com', [{ name: 'computer', input: { action: 'left_click', action_summary: 'Clicks Generate.' } }])).toBe('example.com · clicks Generate')
  expect(caption('example.com', [{ name: 'computer', input: { action: 'scroll' } }])).toBe('example.com · scrolling')
  expect(caption('example.com', [{ name: 'navigate', input: { url: 'https://example.com' } }])).toBe('example.com · opening a page')
})

let t: Twin
beforeAll(async () => { t = await startTwin(undefined, { OTTO_BROWSER_IDLE_MS: '2500' }) }, 60_000)
afterAll(() => t?.stop())

test('a screenshot reaches the phone, throttled, then done after idle', async () => {
  const p = await phone(t)
  const at: number[] = []
  p.ws.addEventListener('message', e => { if (JSON.parse(String(e.data)).type === 'browser') at.push(Date.now()) })
  await post(t, 'computer', { action: 'screenshot', tabId: 7 }, shot('https://example.com/studio?session=secret'))
  const first = await p.until(f => f.type === 'browser' && f.image)
  expect(first.image).toStartWith('data:image/jpeg;base64,')
  expect(Buffer.from(first.image.split(',')[1], 'base64').length).toBeLessThan(80_000)
  expect(first.caption).toBe('example.com · looking')
  expect(first.url).toBe('https://example.com/studio')
  expect(typeof first.ts).toBe('number')

  // Five calls in a burst: one more frame, a second later, carrying the last caption and the picture still.
  const n = at.length
  for (let i = 1; i <= 5; i++) await post(t, 'computer', { action: 'left_click', tabId: 7, action_summary: `Clicks button ${i}` }, [ctx('Example page', 'https://example.com/studio')])
  const last = await p.until(f => f.type === 'browser' && f.caption === 'example.com · clicks button 5', 3000)
  expect(last.image).toStartWith('data:image/jpeg')
  const burst = at.slice(n - 1)
  expect(burst.length).toBeLessThanOrEqual(3) // first frame + at most one per second for ~1 s of burst
  for (let i = 1; i < burst.length; i++) expect(burst[i] - burst[i - 1]).toBeGreaterThanOrEqual(900)

  // A phone that connects now gets the tile; then quiet → done.
  const late = await phone(t)
  expect(await late.until(f => f.type === 'browser' && f.caption === 'example.com · clicks button 5', 3000)).toBeTruthy()
  expect(await p.until(f => f.type === 'browser' && f.done, 6000)).toEqual({ type: 'browser', done: true })
  const after = await phone(t)
  await Bun.sleep(300)
  expect(after.got.some(f => f.type === 'browser')).toBe(false)
  p.close(); late.close(); after.close()
}, 30_000)

test('sign-in and checkout pages go caption-only, and the turn ending ends the tile', async () => {
  const p = await phone(t)
  await post(t, 'computer', { action: 'screenshot', tabId: 7 }, shot('https://example.com/account/login?next=/'))
  const f = await p.until(f => f.type === 'browser' && f.caption)
  expect(f).toMatchObject({ image: null, caption: 'example.com · looking', url: 'https://example.com/account/login' })

  // A checkout at "/" that only a read of the page gives away: no picture until the tab leaves it.
  await post(t, 'read_page', { tabId: 8 }, [{ type: 'text', text: 'form\n label "Card number"\n textbox' }, ctx('Shop', 'https://shop.example/', 8)])
  await post(t, 'computer', { action: 'screenshot', tabId: 8 }, shot('https://shop.example/', 'Shop'))
  await Bun.sleep(2500)
  expect(p.got.filter(f => f.type === 'browser' && f.url === 'https://shop.example/').every(f => f.image === null)).toBe(true)
  expect(p.got.some(f => f.type === 'browser' && f.url === 'https://shop.example/')).toBe(true)

  await t.hook({ hook_event_name: 'Stop' })
  expect(await p.until(f => f.type === 'browser' && f.done, 2000)).toBeTruthy()
  p.close()
}, 30_000)
