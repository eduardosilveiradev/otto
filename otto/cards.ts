/** App-only structured content. All strings are plain text. */
export type Button = { label: string } & ({ data: string } | { url: string } | { copy: string })
export type Block =
  | { type: 'stat'; value: string; label?: string; delta?: string; tone?: 'up' | 'down' | 'neutral' }
  | { type: 'list'; items: { title: string; detail?: string; trailing?: string; icon?: string }[] }
  | { type: 'table'; columns: string[]; rows: string[][] }
  | { type: 'bars'; items: { label: string; value: number }[]; unit?: string }
  | { type: 'sparkline'; values: number[]; label?: string }
  | { type: 'progress'; value: number; label: string; detail?: string }
  | { type: 'timeline'; items: { time: string; title: string; detail?: string; done?: boolean }[] }
  | { type: 'keyvalue'; items: { key: string; value: string }[] }
  | { type: 'checklist'; items: { text: string; done: boolean }[] }
  | ({ type: 'image'; alt: string } & ({ file: string; url?: never } | { url: string; file?: never }))
  | { type: 'text'; text: string; style?: 'body' | 'caption' }
export type Card = { title?: string; blocks: Block[]; actions?: Button[] }

type ObjectValue = Record<string, unknown>
export function validateCard(x: unknown): { ok: true; card: Card } | { ok: false; errors: string[] } {
  const errors: string[] = []
  const fail = (path: string, message: string) => { errors.push(`${path}: ${message}`) }
  const object = (v: unknown, p: string): v is ObjectValue => {
    if (v === null || typeof v !== 'object' || Array.isArray(v)) { fail(p, 'expected object'); return false }
    return true
  }
  const fields = (v: ObjectValue, p: string, allowed: string[]) => {
    for (const k of Object.keys(v)) if (!allowed.includes(k)) fail(p ? `${p}.${k}` : k, 'unknown field')
  }
  const str = (v: unknown, p: string, max = 120) => {
    if (typeof v !== 'string') fail(p, 'expected string')
    else if (Array.from(v).length > max) fail(p, `maximum ${max} characters`)
  }
  const num = (v: unknown, p: string) => {
    if (typeof v !== 'number' || !Number.isFinite(v)) fail(p, 'expected number')
  }
  const bool = (v: unknown, p: string) => { if (typeof v !== 'boolean') fail(p, 'expected boolean') }
  const opt = (v: ObjectValue, k: string, p: string, check = str) => { if (k in v) check(v[k], `${p}.${k}`) }
  const choice = (v: unknown, p: string, values: string[]) => {
    if (!values.includes(v as string)) fail(p, `expected ${values.join('|')}`)
  }
  const array = (v: unknown, p: string, min: number, max: number, check: (v: unknown, p: string) => void) => {
    if (!Array.isArray(v)) { fail(p, 'expected array'); return }
    if (v.length < min || v.length > max) fail(p, `expected ${min}–${max} items`)
    v.forEach((item, i) => check(item, `${p}[${i}]`))
  }
  const items = (v: ObjectValue, p: string, max: number, required: string[], optional: string[] = [], numbers: string[] = [], booleans: string[] = []) => {
    array(v.items, `${p}.items`, 0, max, (item, ip) => {
      if (!object(item, ip)) return
      fields(item, ip, [...required, ...optional])
      for (const k of required) (numbers.includes(k) ? num : booleans.includes(k) ? bool : str)(item[k], `${ip}.${k}`)
      for (const k of optional) opt(item, k, ip, booleans.includes(k) ? bool : str)
    })
  }
  if (!object(x, 'card')) return { ok: false, errors }
  fields(x, '', ['title', 'blocks', 'actions'])
  if ('title' in x) str(x.title, 'title', 80)
  array(x.blocks, 'blocks', 1, 12, (b, p) => {
    if (!object(b, p)) return
    const allowed: Record<string, string[]> = {
      stat: ['value', 'label', 'delta', 'tone'], list: ['items'], table: ['columns', 'rows'],
      bars: ['items', 'unit'], sparkline: ['values', 'label'], progress: ['value', 'label', 'detail'],
      timeline: ['items'], keyvalue: ['items'], checklist: ['items'], image: ['file', 'url', 'alt'], text: ['text', 'style'],
    }
    if (typeof b.type !== 'string' || !Object.hasOwn(allowed, b.type)) { fail(`${p}.type`, 'unknown block type'); return }
    fields(b, p, ['type', ...allowed[b.type]])
    switch (b.type) {
      case 'stat':
        str(b.value, `${p}.value`, 24); opt(b, 'label', p); opt(b, 'delta', p)
        if ('tone' in b) choice(b.tone, `${p}.tone`, ['up', 'down', 'neutral'])
        break
      case 'list': items(b, p, 20, ['title'], ['detail', 'trailing', 'icon']); break
      case 'table':
        array(b.columns, `${p}.columns`, 1, 4, str)
        array(b.rows, `${p}.rows`, 0, 20, (row, rp) => {
          if (!Array.isArray(row)) { fail(rp, 'expected array'); return }
          if (Array.isArray(b.columns) && row.length !== b.columns.length) fail(rp, `expected ${b.columns.length} cells`)
          row.forEach((cell, i) => str(cell, `${rp}[${i}]`))
        })
        break
      case 'bars': items(b, p, 12, ['label', 'value'], [], ['value']); opt(b, 'unit', p); break
      case 'sparkline': array(b.values, `${p}.values`, 2, 60, num); opt(b, 'label', p); break
      case 'progress':
        num(b.value, `${p}.value`)
        if (typeof b.value === 'number' && Number.isFinite(b.value) && (b.value < 0 || b.value > 1)) fail(`${p}.value`, 'expected number in 0..1')
        str(b.label, `${p}.label`); opt(b, 'detail', p); break
      case 'timeline': items(b, p, 20, ['time', 'title'], ['detail', 'done'], [], ['done']); break
      case 'keyvalue': items(b, p, 12, ['key', 'value']); break
      case 'checklist': items(b, p, 20, ['text', 'done'], [], [], ['done']); break
      case 'image':
        str(b.alt, `${p}.alt`)
        if (('file' in b ? 1 : 0) + ('url' in b ? 1 : 0) !== 1) fail(p, 'expected exactly one of file or url')
        opt(b, 'file', p); opt(b, 'url', p)
        if (typeof b.url === 'string') {
          try { if (!b.url.startsWith('https://') || new URL(b.url).protocol !== 'https:') throw new Error() } catch { fail(`${p}.url`, 'expected https URL') }
        }
        break
      case 'text':
        str(b.text, `${p}.text`, 400)
        if ('style' in b) choice(b.style, `${p}.style`, ['body', 'caption'])
        break
    }
  })
  if ('actions' in x) array(x.actions, 'actions', 0, 4, (a, p) => {
    if (!object(a, p)) return
    fields(a, p, ['label', 'data', 'url', 'copy'])
    str(a.label, `${p}.label`)
    if (['data', 'url', 'copy'].filter(k => k in a).length !== 1) fail(p, 'expected exactly one of data, url or copy')
    for (const k of ['data', 'url', 'copy']) opt(a, k, p)
    if (typeof a.url === 'string') {
      try { if (!a.url.startsWith('https://') || new URL(a.url).protocol !== 'https:') throw new Error() } catch { fail(`${p}.url`, 'expected https URL') }
    }

  })
  return errors.length ? { ok: false, errors } : { ok: true, card: x as Card }
}
