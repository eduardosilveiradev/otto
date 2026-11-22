import { describe, expect, test } from 'bun:test'
import { BUTTON_DATA_MAX, REVIEW_LABEL, lintDraft, reviewTrigger } from '../draftreview.ts'

const DRAFT = 'r-1111111111111111111'
const draftButtons = [
  { label: 'send ✓', data: `send draft ${DRAFT}` },
  { label: 'discard', data: `discard draft ${DRAFT}` },
]

describe('lintDraft', () => {
  test('leaves non-draft replies alone', () => {
    const r = lintDraft('**hi**', [{ label: 'done', data: 'close loop abc' }])
    expect(r).toEqual({ ok: true, text: '**hi**', buttons: [{ label: 'done', data: 'close loop abc' }], draft: false })
  })

  test('blocks a draft with no heading', () => {
    const r = lintDraft('Hi Alex,\nsee you Friday.', draftButtons)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('draft to <name>:')
  })

  test('fixes a near-miss heading', () => {
    for (const head of ['**Draft for Mum**', 'Draft to Mum', 'draft to Mum :', '_draft to Mum:_']) {
      const r = lintDraft(`${head}\nCiao mamma`, draftButtons)
      expect(r.ok && r.text).toBe('draft to Mum:\nCiao mamma')
    }
  })

  test('adds a self-contained review button naming the draft', () => {
    const r = lintDraft('draft to Alex:\nhi', draftButtons)
    if (!r.ok) throw new Error(r.reason)
    expect(r.draft).toBe(true)
    const review = r.buttons.find(b => b.label === REVIEW_LABEL)!
    expect(review.data).toBe(`ask someone to review draft ${DRAFT}`)
    expect(Buffer.byteLength(review.data!)).toBeLessThanOrEqual(BUTTON_DATA_MAX)
  })

  test('no draft id: no review button, a note saying why', () => {
    const r = lintDraft('draft to Alex:\nhi', [{ label: 'send ✓', data: 'send the reply to Alex' }, { label: 'discard', data: 'discard it' }])
    if (!r.ok) throw new Error(r.reason)
    expect(r.buttons).toHaveLength(2)
    expect(r.note).toContain('send draft <id>')
  })

  test('the review email gets no review button of its own', () => {
    const r = lintDraft('draft to Mum:\ncan you check this?', [
      { label: 'send ✓', data: `send review r-1111111111111111111 of ${DRAFT}` },
      { label: 'discard', data: 'discard draft r-1111111111111111111' },
    ])
    if (!r.ok) throw new Error(r.reason)
    expect(r.buttons.some(b => b.label === REVIEW_LABEL)).toBe(false)
  })

  test('does not add a second review button or a seventh button', () => {
    const six = [...draftButtons, ...[1, 2, 3, 4].map(i => ({ label: `x${i}`, data: `x ${i}` }))]
    const r = lintDraft('draft to A:\nb', six)
    expect(r.ok && r.buttons).toHaveLength(6)
  })
})

describe('review data is self-contained', () => {
  test('trigger and loop name every id and the reviewer', () => {
    const r = reviewTrigger({ draftId: DRAFT, threadId: '18c2a3b4c5d6e7f8', reviewer: 'Mum', reviewerEmail: 'mum@example.com', reviewThreadId: '19d0aa11bb22cc33' })
    expect(r.condition).toContain('mum@example.com')
    expect(r.condition).toContain('19d0aa11bb22cc33')
    for (const id of [DRAFT, '18c2a3b4c5d6e7f8', '19d0aa11bb22cc33', 'mum@example.com']) expect(r.action).toContain(id)
    expect(r.action).toContain(`send draft ${DRAFT}`)
    expect(r.action).toContain('draft to <recipient>:')
    for (const id of [DRAFT, '19d0aa11bb22cc33']) expect(r.loop).toContain(id)
    expect(r.label.length).toBeLessThanOrEqual(60)
  })

  test('refuses empty ids', () => {
    expect(() => reviewTrigger({ draftId: DRAFT, reviewer: 'Mum', reviewerEmail: '', reviewThreadId: 't' })).toThrow('reviewer_email')
  })
})
