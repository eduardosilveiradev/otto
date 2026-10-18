// Text of a file: PDFs via poppler's pdftotext, else utf8. A one-line note when pdftotext is missing.
import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'

export function fileText(path: string): string {
  if (!/\.pdf$/i.test(path)) return readFileSync(path, 'utf8')
  const r = spawnSync('pdftotext', ['-layout', path, '-'], { encoding: 'utf8', maxBuffer: 20 << 20 })
  if (r.error || r.status !== 0) return '[pdftotext unavailable or failed: install poppler (brew install poppler) or pass the text]'
  return r.stdout
}
