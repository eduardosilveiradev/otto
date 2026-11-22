import type { Exec } from './codejobs.ts'

const IMAGE_LIMIT = 5 * 1024 * 1024
const PR_LIMIT = 20 * 1024 * 1024
const CACHE_LIMIT = 50 * 1024 * 1024
const allowed = (u: URL) => u.protocol === 'https:' && !u.username && !u.password && (!u.port || u.port === '443') &&
  (['raw.githubusercontent.com', 'private-user-images.githubusercontent.com', 'objects.githubusercontent.com'].includes(u.hostname) ||
    (u.hostname === 'github.com' && u.pathname.startsWith('/user-attachments/')))

export class PrImages {
  private cache = new Map<string, { data: string; bytes: number }>()
  private bytes = 0
  constructor(private exec: Exec, private fetchImage: typeof fetch = fetch) {}

  async inline<T>(detail: T, repo: string, head: { headRefOid?: string; headRefName?: string; headRepository?: { name?: string }; headRepositoryOwner?: { login?: string } }): Promise<T> {
    let remaining = PR_LIMIT
    let token: Promise<string | undefined> | undefined
    const resolve = async (source: string) => {
      try {
        let url = new URL(source.replaceAll('&amp;', '&'))
        // A repo file linked as github.com/<owner>/<repo>/blob|raw/<ref>/<path> (often ?raw=true) is the raw file.
        const file = url.hostname === 'github.com' && /^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/(.+)$/.exec(url.pathname)
        if (file) url = new URL(`https://raw.githubusercontent.com/${file[1]}/${file[2]}/${file[3]}`)
        if (!allowed(url)) return source
        const [owner, name] = repo.split('/')
        const prefix = `/${head.headRepositoryOwner?.login ?? owner}/${head.headRepository?.name ?? name}/`
        const branch = head.headRefName
        let fallback: URL | undefined
        if (url.hostname === 'raw.githubusercontent.com' && head.headRefOid && branch && url.pathname.startsWith(`${prefix}${branch}/`)) {
          fallback = new URL(url)
          fallback.pathname = `${prefix}${head.headRefOid}/${url.pathname.slice(prefix.length + branch.length + 1)}`
        }
        const key = fallback?.href ?? url.href
        let image = this.cache.get(key)
        if (!image) {
          token ??= this.exec(['gh', 'auth', 'token'], undefined, 15_000).then(t => t?.trim()).catch(() => undefined)
          const auth = await token
          if (!auth || remaining <= 0) return source
          const request = async (target: URL) => {
            for (let redirects = 0; redirects < 5; redirects++) {
              if (!allowed(target)) throw new Error('Unsupported image redirect')
              const response = await this.fetchImage(target.href, { headers: { Authorization: `token ${auth}` }, redirect: 'manual', signal: AbortSignal.timeout(15_000) })
              if ([301, 302, 303, 307, 308].includes(response.status)) {
                await response.body?.cancel()
                target = new URL(response.headers.get('location') ?? '', target)
                continue
              }
              return response
            }
            throw new Error('Too many redirects')
          }
          let response = await request(url)
          if (response.status === 404 && fallback) {
            await response.body?.cancel()
            response = await request(fallback)
          }
          const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
          const limit = Math.min(IMAGE_LIMIT, remaining)
          if (!response.ok || !mime || !/^image\/(png|jpeg|gif|webp|avif|svg\+xml|bmp|x-icon)$/.test(mime) || Number(response.headers.get('content-length')) > limit || !response.body) {
            await response.body?.cancel()
            return source
          }
          const reader = response.body.getReader()
          const chunks: Uint8Array[] = []
          let bytes = 0
          try {
            while (true) {
              const part = await reader.read()
              if (part.done) break
              bytes += part.value.byteLength
              if (bytes > limit) { await reader.cancel(); return source }
              chunks.push(part.value)
            }
          } finally { reader.releaseLock() }
          image = { data: `data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`, bytes }
          while (this.bytes + bytes > CACHE_LIMIT && this.cache.size) {
            const oldest = this.cache.keys().next().value!
            this.bytes -= this.cache.get(oldest)!.bytes
            this.cache.delete(oldest)
          }
          this.cache.set(key, image)
          this.bytes += bytes
        }
        if (image.bytes > remaining) return source
        remaining -= image.bytes
        return image.data
      } catch { return source }
    }
    const body = async (text: string) => {
      // Keep surrounding Markdown/HTML intact, replacing only image destinations.
      const pattern = /!\[(?:\\.|[^\]\\])*\]\(\s*(?:<([^>]+)>|([^\s)]+))(?:\s+["'][^"']*["'])?\s*\)|<img\b[^>]*?\s+src\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>/gi
      let result = '', end = 0
      for (const match of text.matchAll(pattern)) {
        const source = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5]
        const replacement = await resolve(source)
        result += text.slice(end, match.index) + match[0].replace(source, replacement)
        end = match.index! + match[0].length
      }
      return result + text.slice(end)
    }
    const walk = async (value: any): Promise<any> => {
      if (Array.isArray(value)) { const out = []; for (const entry of value) out.push(await walk(entry)); return out }
      if (!value || typeof value !== 'object') return value
      const out: Record<string, any> = {}
      for (const [key, entry] of Object.entries(value)) out[key] = key === 'body' && typeof entry === 'string' ? await body(entry) : await walk(entry)
      return out
    }
    return walk(detail)
  }
}
