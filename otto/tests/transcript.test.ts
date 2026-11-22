import { test, expect } from 'bun:test'
import { markOtto, normalizeTranscript, Transcripts, redact } from '../transcript.ts'
// Assemble credential-shaped fixtures at runtime so repository scanners see no credentials.
const fakeToken = ['gh', 'p_'].join('') + 'x'.repeat(36)
const bearer = (value: string) => 'Bearer ' + value
const t=(s:number)=>`2026-01-01T00:00:${String(s).padStart(2,'0')}.000Z`
const fixture=()=>({thread:{id:'thread'},messages:[{id:'u',role:'user',text:'Start here',createdAt:t(0)},{id:'a',role:'assistant',text:'Done',createdAt:t(5)}],turnItems:[
  {id:'a-item',messageId:'a',type:'assistant_message',text:'Done',startedAt:t(5)},
  {id:'tool',threadId:'thread',type:'dynamic_tool',toolName:'exec',startedAt:t(2),completedAt:t(4),status:'completed',input:{api_key:'placeholder-secret',command:'x'.repeat(5000)},output:'Authorization: ' + bearer(fakeToken) + '\n'+'z'.repeat(5000)},
  {id:'think',type:'reasoning',text:'Check the inputs',startedAt:t(1)},
  {id:'error',type:'error',failure:{message:'failed'},startedAt:t(6)},
],runtimeRequests:[{id:'q',resolvedAt:t(3),answers:{choice:'Keep both'}}]})
test('full recorded shape: order, messages without duplicates, thinking, answers, errors and tool duration',()=>{
 const rows=normalizeTranscript(fixture())
 expect(rows.map(r=>r.kind)).toEqual(['user','thinking','tool','user','assistant','error'])
 expect(rows[2]!.tool).toMatchObject({name:'exec',status:'completed',durationMs:2000,inputTruncated:true,outputTruncated:true})
 expect(rows[2]!.tool!.output.length).toBe(4000)
 expect(JSON.stringify(rows)).not.toContain('placeholder-secret')
 expect(JSON.stringify(rows)).not.toContain(fakeToken)
 expect(rows[2]!.tool!.input).toContain('[REDACTED]')
})
test('redacts common keys, headers, private keys and credentials inside prose',()=>{
 const text=['sk', 'proj', ''].join('-')+'a'.repeat(30)+' '+['github', 'pat', ''].join('_')+'b'.repeat(25)+' token=sample-value Authorization: '+bearer(fakeToken)+'\n'+['-----BEGIN', 'PRIVATE KEY-----'].join(' ')+'\nsecret\n'+['-----END', 'PRIVATE KEY-----'].join(' ')
 const out=redact(text)
 expect(out).not.toContain(fakeToken); expect(out).not.toContain('sample-value'); expect(out).not.toContain('secret'); expect(out).not.toContain('aaaa'); expect(out).not.toContain('bbbb')
})
test('cursor upserts evolving rows, coalesces polling, validates by version, resets expired/foreign cursors',async()=>{
 let now=0,version='one',calls=0,loads=0
 const p=fixture()
 const fake={async transcriptRead(id:string,cached?:string){calls++; if(cached===version)return {updatedAt:version}; loads++; return {updatedAt:version,projection:structuredClone(p)}}}
 const api=new Transcripts(fake,()=>now)
 const [a,b]=await Promise.all([api.read('thread'),api.read('thread')])
 expect(a.cursor).toBe(b.cursor); expect(calls).toBe(1)
 expect((await api.read('thread',a.cursor)).items).toEqual([])
 now+=4000; expect((await api.read('thread',a.cursor)).items).toEqual([]); expect(loads).toBe(1)
 version='two'; now+=4000; p.turnItems[1]!.status='failed'
 const changed=await api.read('thread',a.cursor)
 expect(changed.reset).toBe(false); expect(changed.items.length).toBe(1); expect(changed.items[0]!.tool!.status).toBe('failed')
 expect((await api.read('other',a.cursor)).reset).toBe(true)
 now+=600001; expect((await api.read('thread',changed.cursor)).reset).toBe(true)
})

test('real T3 client uses full HTTP history and one unary socket, with no subscriptions',async()=>{
 const {T3Client}=await import('../t3.ts')
 const {mkdtempSync,writeFileSync,rmSync}=await import('fs')
 const {tmpdir}=await import('os')
 const {join}=await import('path')
 const dir=mkdtempSync(join(tmpdir(),'otto-transcript-'))
 const token='placeholder-session'; writeFileSync(join(dir,'token'),token)
 const tags:string[]=[]; const paths:string[]=[]; const active=new Set<unknown>(); let opened=0
 const p=fixture()
 const server=Bun.serve({port:0,
  fetch(req,srv){
   expect(req.headers.get('authorization')).toBe(bearer(token))
   const path=new URL(req.url).pathname
   if(path==='/ws')return srv.upgrade(req)?undefined:new Response(null,{status:400})
   paths.push(path); expect(req.headers.get('x-t3-orchestration-protocol')).toBe('2')
   if(path.endsWith('/bounded'))return Response.json({projection:{thread:{id:'thread',updatedAt:'one'}}})
   return Response.json({projection:{...p,turnItems:p.turnItems.map(i=>i.type==='dynamic_tool'?{...i,input:'summary',output:undefined,outputOmitted:true}:i)}})
  },websocket:{open(ws){opened++;active.add(ws)},close(ws){active.delete(ws)},message(ws,raw){
   const m=JSON.parse(String(raw)); tags.push(m.tag)
   ws.send(JSON.stringify({_tag:'Exit',requestId:m.id,exit:{_tag:'Success',value:{item:p.turnItems[1]}}}))
  }}
 })
 try{
  const api=new Transcripts(new T3Client({origin:`http://127.0.0.1:${server.port}`,tokenFile:join(dir,'token')}),()=>10_000)
  const result=await api.read('thread')
  expect(result.items.find(i=>i.kind==='tool')!.tool!.input).toContain('[REDACTED]')
  expect(opened).toBe(1); expect(tags).toEqual(['orchestration.getTurnItem'])
  for(let i=0;i<20&&active.size;i++)await Bun.sleep(5)
  expect(active.size).toBe(0)
  expect((await api.read('thread',result.cursor)).items).toEqual([])
  expect(paths.length).toBe(2)
 }finally{server.stop(true);rmSync(dir,{recursive:true,force:true})}
})

test('route validates method and id before reading T3',async()=>{
 const {CodeJobs}=await import('../codejobs.ts')
 const jobs=new CodeJobs({file:'/nonexistent/code-jobs.json',t3:{} as any})
 const path='/app/jobs/transcript'
 expect((await jobs.handle(new Request(`http://localhost${path}`,{method:'POST'}),path)).status).toBe(405)
 expect((await jobs.handle(new Request(`http://localhost${path}`),path)).status).toBe(400)
 expect((await jobs.handle(new Request(`http://localhost${path}?id=missing`),path)).status).toBe(404)
})

test('equal timestamps retain T3 ordinal order rather than sorting ids',()=>{
 const items=normalizeTranscript({turnItems:[
  {id:'a',ordinal:2,type:'reasoning',text:'Second',startedAt:t(1)},
  {id:'z',ordinal:1,type:'reasoning',text:'First',startedAt:t(1)},
 ]})
 expect(items.map(i=>i.text)).toEqual(['First','Second'])
})

test('markOtto: the brief Otto sent reads as Otto, the user\'s own messages stay theirs', () => {
  const items = [
    { id: 'a', ts: '2026-11-06T12:00:00Z', kind: 'user' as const, text: 'Fix the  thread\njump.' },
    { id: 'b', ts: '2026-11-06T12:01:00Z', kind: 'assistant' as const, text: 'Fix the thread jump.' },
    { id: 'c', ts: '2026-11-06T12:02:00Z', kind: 'user' as const, text: 'also check dark mode' },
  ]
  expect(markOtto(items, ['Fix the thread jump.']).map(i => i.kind)).toEqual(['otto', 'assistant', 'user'])
  expect(markOtto(items, ['']).map(i => i.kind)).toEqual(['user', 'assistant', 'user'])
})

test('300 tool bodies stay lazy, cache validation is bounded, and expansion is one RPC',async()=>{
 const {T3Client}=await import('../t3.ts')
 const {mkdtempSync,writeFileSync,rmSync}=await import('fs')
 const {tmpdir}=await import('os'); const {join}=await import('path')
 const dir=mkdtempSync(join(tmpdir(),'otto-lazy-')); writeFileSync(join(dir,'token'),'placeholder-session')
 let now=10000,version='one';const paths:string[]=[];const calls:any[]=[]
 const items=Array.from({length:300},(_,n)=>({id:String(n),threadId:'thread',type:'dynamic_tool',toolName:'exec',startedAt:t(1),status:'completed',outputOmitted:true}))
 const server=Bun.serve({port:0,fetch(req,srv){
  const path=new URL(req.url).pathname
  if(path==='/ws')return srv.upgrade(req)?undefined:new Response(null,{status:400})
  paths.push(path)
  if(path.endsWith('/bounded'))return Response.json({projection:{thread:{id:'thread',updatedAt:version}}})
  return Response.json({projection:{thread:{id:'thread'},updatedAt:'newer',turnItems:items,visibleTurnItems:items.map(item=>({item}))}})
 },websocket:{message(ws,raw){const m=JSON.parse(String(raw));calls.push(m)
  ws.send(JSON.stringify({_tag:'Exit',requestId:m.id,exit:{_tag:'Success',value:{item:{...items[0],id:m.payload.itemId,input:{token:'private-value'},output:'loaded'}}}}))
 }}})
 try{
  const client=new T3Client({origin:`http://127.0.0.1:${server.port}`,tokenFile:join(dir,'token')})
  const api=new Transcripts(client,()=>now)
  const page=await api.read('thread',null,true)
  expect(page.items.length).toBe(300);expect(page.items[0]!.tool!.bodyOmitted).toBe(true)
  expect(paths).toEqual(['/api/orchestration/threads/thread/bounded','/api/orchestration/threads/thread']);expect(calls.length).toBe(0)
  now+=4000;await api.read('thread',page.cursor,true)
  expect(paths.length).toBe(3);expect(paths[2]).toEndWith('/bounded');expect(calls.length).toBe(0)
  const body=normalizeTranscript({turnItems:[await client.transcriptItem('thread','0')]})[0]!
  expect(body.tool!.output).toBe('loaded');expect(body.tool!.bodyOmitted).toBeUndefined()
  expect(body.tool!.input).not.toContain('private-value');expect(calls.length).toBe(1)
  expect(calls[0].payload).toEqual({threadId:'thread',itemId:'0'})
  // Snapshot says newer, but the pre-snapshot version is the cache key.
  version='newer';now+=4000;await api.read('thread',page.cursor,true);expect(paths.length).toBe(5)
  await api.read('thread');expect(calls.length).toBe(301)
 }finally{server.stop(true);rmSync(dir,{recursive:true,force:true})}
})

test('item route is job-bound, validates before RPC, and redacts the returned body',async()=>{
 const {CodeJobs}=await import('../codejobs.ts')
 const {mkdtempSync,writeFileSync,rmSync}=await import('fs')
 const {tmpdir}=await import('os');const {join}=await import('path')
 const dir=mkdtempSync(join(tmpdir(),'otto-item-'));const file=join(dir,'jobs.json')
 writeFileSync(file,JSON.stringify([{id:'job',threadId:'thread',brief:'Do it',steps:[],createdAt:t(0)}]))
 const calls:any[]=[]
 const jobs=new CodeJobs({file,t3:{async transcriptItem(threadId:string,itemId:string){calls.push([threadId,itemId]);return {...fixture().turnItems[1],id:itemId}}} as any})
 const path='/app/jobs/transcript/item'
 const read=(q:string)=>jobs.handle(new Request(`http://localhost${path}?${q}`),path)
 try{
  expect((await read('id=job')).status).toBe(400)
  expect((await read('id=job&item=item:other:tool')).status).toBe(400)
  expect(calls).toEqual([])
  const res=await read('id=job&item=item:thread:tool');expect(res.status).toBe(200)
  const body=await res.json();expect(body.item.id).toBe('item:thread:tool')
  expect(JSON.stringify(body)).not.toContain('placeholder-secret');expect(JSON.stringify(body)).not.toContain(fakeToken)
  expect(calls).toEqual([['thread','tool']])
 }finally{rmSync(dir,{recursive:true,force:true})}
})
