/**
 * GET /app/jobs/transcript?id=<jobId>[&after=<opaque cursor>][&lazy=1]
 * → {items: [{id,ts,kind,text?,tool?:{name,input,output,status,durationMs,
 * inputTruncated,outputTruncated}}], cursor, reset}.
 * kind: user | otto | assistant | tool | thinking | error | system (otto: a message Otto sent the agent, such as the brief); ts is ISO UTC.
 * Tool input is pretty JSON (individual strings capped at 4000); output is capped
 * at 4000 characters. Secrets are redacted BEFORE truncation, including prose.
 * Items are chronological; ids are stable. Incremental items are UPSERTS: an
 * in-progress message/tool may change under the same id. reset=true means replace
 * the client's list (first fetch, expired cursor, restart, or removed history).
 * Cursors are thread-bound, opaque and process-local; keep the returned cursor.
 * Reads coalesce; normalized/redacted history is cached by thread updatedAt, with
 * a 3s validation TTL, 10min idle eviction and at most 32 cached threads.
 * T3 source: orchestration-v2/http.ts and WireProjection.ts. The HTTP full snapshot
 * is unbounded (the compatibility websocket projection is NOT). Omitted tool
 * bodies load on expansion with lazy=1; legacy callers hydrate on ONE socket.
 * GET /app/jobs/transcript/item?id=<jobId>&item=<rowId> returns {item}, normalized
 * and redacted like the transcript. Lazy and full reads use separate caches.
 * No database fallback and no provider-private transcript files.
 */
import { createHash, randomUUID } from 'crypto'
type Row = Record<string, any>
export type TranscriptItem = { id: string; ts: string; kind: 'user'|'otto'|'assistant'|'tool'|'thinking'|'error'|'system'; text?: string; tool?: {name:string; input:string; output:string; status:string; durationMs:number|null; inputTruncated:boolean; outputTruncated:boolean; bodyOmitted?:boolean} }
export type TranscriptSource = { transcriptRead(threadId:string, cachedUpdatedAt?:string, lazy?:boolean): Promise<{updatedAt:string; projection?:Row}>; transcriptItem?(threadId:string,itemId:string):Promise<Row> }

export function redact(text:string):string {
  return text.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:sk-(?:ant-|proj-)?[\w-]{12,}|gh[pousr]_[\w]{16,}|github_pat_[\w_]{16,}|xox[baprs]-[\w-]{10,}|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[REDACTED]')
    .replace(/(\b(?:Bearer|Basic)\s+)[\w.+/=-]+/gi, '$1[REDACTED]')
    .replace(/(["']?(?:[\w-]{0,64}(?:token|secret|password|api[_-]?key|access[_-]?key|authorization|cookie)[\w-]{0,64})["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s,;&}\n]+)/gi, '$1"[REDACTED]"')
}
function pretty(value:unknown, limitStrings=false):{text:string; truncated:boolean} {
  let truncated=false
  const visit=(v:any,key=''):any => {
    if (/token|secret|password|api[_-]?key|access[_-]?key|authorization|cookie/i.test(key)) return '[REDACTED]'
    if (typeof v==='string') { const s=redact(v); if(limitStrings && s.length>4000) { truncated=true; return s.slice(0,4000)+'…' }; return s }
    if(Array.isArray(v)) return v.map(x=>visit(x))
    if(v && typeof v==='object') return Object.fromEntries(Object.entries(v).map(([k,x])=>[redact(k),visit(x,k)]))
    return v
  }
  return {text:redact(JSON.stringify(visit(value),null,2) ?? ''),truncated}
}
export function normalizeTranscript(p:Row):TranscriptItem[] {
  const rows=new Map<string,TranscriptItem>()
  const messages=new Map((p.messages??[]).map((m:Row)=>[m.id,m])) as Map<string,Row>
  for(const m of messages.values()) rows.set(`message:${m.id}`,{id:`message:${m.id}`,ts:m.createdAt,kind:m.role,text:redact(m.text??'')})
  const source=p.visibleTurnItems?.length ? p.visibleTurnItems.map((r:Row)=>r.item) : p.turnItems??[]
  const ordinals = new Map<string, number>()
  for(const i of source) {
    const id=i.messageId ? `message:${i.messageId}` : `item:${i.threadId??p.thread?.id}:${i.id}`
    if (typeof i.ordinal === 'number') ordinals.set(id, i.ordinal)
    const ts=i.startedAt??i.updatedAt
    if(i.messageId && messages.has(i.messageId)) continue
    let row:TranscriptItem={id,ts,kind:'system'}
    if(i.type==='user_message'||i.type==='assistant_message') row={...row,kind:i.type==='user_message'?'user':'assistant',text:redact(i.text??'')}
    else if(i.type==='reasoning') row={...row,kind:'thinking',text:redact(i.text??'')}
    else if(i.type==='error') row={...row,kind:'error',text:pretty(i.failure).text}
    else if(['dynamic_tool','command_execution','file_change','file_search','web_search','subagent'].includes(i.type)) {
      const input=pretty(i.input??i.prompt??i.pattern??i.patterns??{fileName:i.fileName,oldStr:i.oldStr,newStr:i.newStr},true)
      const raw=i.output??i.result??i.results??i.diffStr??i.changes??''
      const output=typeof raw==='string'?redact(raw):pretty(raw).text
      row={...row,kind:'tool',tool:{...(i.bodyOmitted ? {bodyOmitted:true} : {}),name:redact(i.toolName??i.type),input:input.text,output:output.slice(0,4000),inputTruncated:input.truncated,outputTruncated:output.length>4000,status:i.status,durationMs:i.completedAt&&i.startedAt?Math.max(0,Date.parse(i.completedAt)-Date.parse(i.startedAt)):null}}
    } else row.text=redact(i.text??i.message??i.markdown??i.summary??(i.questions?pretty(i.questions).text:i.title??pretty(i).text))
    rows.set(id,row)
  }
  for(const r of p.runtimeRequests??[]) if(r.resolvedAt && (r.answers||r.decision||r.feedback)) {
    const id=`answer:${r.id}`
    rows.set(id,{id,ts:r.resolvedAt,kind:'user',text:pretty({answers:r.answers,decision:r.decision,feedback:r.feedback}).text})
  }
  return [...rows.values()].sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts)||(ordinals.get(a.id) ?? Number.MAX_SAFE_INTEGER)-(ordinals.get(b.id) ?? Number.MAX_SAFE_INTEGER))
}
/** Marks the user-role messages Otto wrote (the job's brief) as kind "otto", so a client can tell them from the user's own. */
export function markOtto(items:TranscriptItem[],sent:string[]):TranscriptItem[] {
  const norm=(t:string)=>t.replace(/\s+/g,' ').trim()
  const mine=new Set(sent.map(norm).filter(Boolean))
  return items.map(i=>i.kind==='user'&&i.text&&mine.has(norm(i.text))?{...i,kind:'otto'}:i)
}
const hash=(i:TranscriptItem)=>createHash('sha256').update(JSON.stringify(i)).digest('hex')
type Version={cursor:string; hashes:Map<string,string>}
export class Transcripts {
  private cache=new Map<string,{at:number; checked:number; updatedAt?:string; items:TranscriptItem[]; versions:Version[]}>()
  private pending=new Map<string,Promise<void>>()
  constructor(private source:TranscriptSource,private now=Date.now) {}
  async read(threadId:string,after?:string|null,lazy=false) {
    const key=JSON.stringify([threadId,lazy])
    for(const [k,v] of this.cache) if(this.now()-v.at>600_000) this.cache.delete(k)
    let task=this.pending.get(key)
    if(!task) {
      task=this.refresh(threadId,key,lazy).finally(()=>this.pending.delete(key)); this.pending.set(key,task)
    }
    await task
    const c=this.cache.get(key)!
    c.at=this.now()
    const old=c.versions.find(v=>v.cursor===after)
    const latest=c.versions.at(-1)!
    const removed=old && [...old.hashes.keys()].some(id=>!latest.hashes.has(id))
    const reset=!old||!!removed
    return {items:reset?c.items:c.items.filter(i=>old.hashes.get(i.id)!==latest.hashes.get(i.id)),cursor:latest.cursor,reset}
  }
  private async refresh(id:string,key:string,lazy:boolean) {
    const c=this.cache.get(key)
    if(c && this.now()-c.checked<3000) return
    const result=await this.source.transcriptRead(id,c?.updatedAt,lazy)
    if(c && !result.projection) {c.checked=this.now(); return}
    if(!result.projection) throw new Error('T3 returned no transcript')
    const items=normalizeTranscript(result.projection)
    const versions=[...(c?.versions??[]),{cursor:randomUUID(),hashes:new Map(items.map(i=>[i.id,hash(i)]))}].slice(-16)
    if(this.cache.size>=32&&!c) this.cache.delete(this.cache.keys().next().value!)
    this.cache.set(key,{at:this.now(),checked:this.now(),updatedAt:result.updatedAt,items,versions})
  }
}
