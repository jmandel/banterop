import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { A2APart, A2ATask, A2AStatus } from '../shared/a2a-types'
import type { ServerEvent } from '../shared/backchannel-types'

// Minimal A2A client (JSON-RPC over POST; SSE for streaming)
class A2AClient {
  constructor(private endpoint: string) {}
  private ep() { return this.endpoint }

  async *messageStreamParts(parts: A2APart[], taskId?: string, signal?: AbortSignal) {
    const body = { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'message/stream', params: { message: { messageId: crypto.randomUUID(), ...(taskId ? { taskId } : {}), parts } } }
    const res = await fetch(this.ep(), { method: 'POST', headers: { 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify(body), signal })
    if (!res.ok || !res.body) throw new Error('message/stream failed: ' + res.status)
    for await (const obj of sseToObjects(res.body)) yield obj
  }
  async *tasksResubscribe(taskId: string, signal?: AbortSignal) {
    const body = { jsonrpc: '2.0', id: crypto.randomUUID(), method: 'tasks/resubscribe', params: { id: taskId } }
    const res = await fetch(this.ep(), { method: 'POST', headers: { 'content-type':'application/json', 'accept':'text/event-stream' }, body: JSON.stringify(body), signal })
    if (!res.ok || !res.body) throw new Error('resubscribe failed: ' + res.status)
    for await (const obj of sseToObjects(res.body)) yield obj
  }
  async tasksGet(taskId: string): Promise<A2ATask | null> {
    const body = { jsonrpc:'2.0', id: crypto.randomUUID(), method: 'tasks/get', params: { id: taskId } }
    const res = await fetch(this.ep(), { method:'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body) })
    const j = await res.json()
    return j.result || null
  }
  async cancel(taskId: string) {
    const body = { jsonrpc:'2.0', id: crypto.randomUUID(), method: 'tasks/cancel', params: { id: taskId } }
    await fetch(this.ep(), { method:'POST', headers: { 'content-type':'application/json' }, body: JSON.stringify(body) })
  }
}

async function* sseToObjects(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    for (;;) {
      const i = buf.indexOf('\n\n')
      const j = buf.indexOf('\r\n\r\n')
      const idx = i !== -1 ? i : (j !== -1 ? j : -1)
      const dlen = i !== -1 ? 2 : (j !== -1 ? 4 : 0)
      if (idx === -1) break
      const chunk = buf.slice(0, idx)
      buf = buf.slice(idx + dlen)
      const lines = chunk.replace(/\r/g, '').split('\n')
      for (const line of lines) {
        if (line.startsWith('data:')) {
          const data = line.slice(5).trimStart()
          try { const obj = JSON.parse(data); if (obj && 'result' in obj) yield (obj.result) } catch { /* ignore */ }
        }
      }
    }
  }
}

type Side = 'a'|'b'

function useQuery() {
  const u = new URL(window.location.href)
  const pairId = u.searchParams.get('pairId') || ''
  const role = (u.searchParams.get('role') || 'a') as Side
  return { pairId, role }
}

function App() {
  const { pairId, role } = useQuery()
  const [status, setStatus] = useState<A2AStatus | 'initializing'>('initializing')
  const [taskId, setTaskId] = useState<string | undefined>()
  const [history, setHistory] = useState<Array<{ role:'user'|'agent', text:string }>>([])
  const [text, setText] = useState('')
  const [finality, setFinality] = useState<'none'|'turn'|'conversation'>('turn')
  const [banner, setBanner] = useState<string>('')
  const endpoint = useMemo(() => `${location.origin}/api/bridge/${pairId || ''}/a2a`, [pairId])
  const a2a = useMemo(() => new A2AClient(endpoint), [endpoint])
  const resubAbort = useRef<AbortController | null>(null)
  const streamAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!pairId) return
    if (role === 'b') {
      // responder-only backchannel
      const es = new EventSource(`/pairs/${pairId}/server-events`)
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data)
          const msg: ServerEvent = payload.result
          if (msg.type === 'subscribe') {
            setBanner(`Server instructed to subscribe to ${msg.taskId} (epoch ${msg.epoch})`)
            // resume this task
            if (resubAbort.current) resubAbort.current.abort()
            const ac = new AbortController()
            resubAbort.current = ac
            ;(async () => {
              try {
                // small delay so UI updates cleanly
                await new Promise(r => setTimeout(r, 50))
                for await (const frame of a2a.tasksResubscribe(msg.taskId, ac.signal)) {
                  handleFrame(frame as any)
                }
              } catch {}
            })()
          } else if (msg.type === 'unsubscribe') {
            setBanner('Unsubscribed (reset) — waiting for next task...')
            setHistory([]); setTaskId(undefined); setStatus('initializing')
          } else if (msg.type === 'redirect') {
            setBanner(`Hard reset — new links ready: A ${msg.newPair.aJoinUrl} | B ${msg.newPair.bJoinUrl}`)
          }
        } catch (e) {
          console.error('Bad server-event payload', ev.data, e)
        }
      }
      es.onerror = () => setBanner('Backchannel disconnected — reconnecting...')
      return () => { try { es.close() } catch {} }
    }
  }, [pairId, role, a2a])

  function handleFrame(frame: any) {
    if (!frame) return
    if (frame.kind === 'task') {
      setTaskId(frame.id)
      setStatus(frame.status?.state || 'submitted')
      const msgs = (frame.history || []).map((m:any) => ({ role: m.role, text: (m.parts||[]).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n') }))
      setHistory(msgs)
      return
    }
    if (frame.kind === 'status-update') {
      setStatus(frame.status?.state || 'submitted')
      if (frame.status?.message) {
        const txt = (frame.status.message.parts || []).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n')
        if (txt) setHistory(h => [...h, { role: frame.status.message.role, text: txt }])
      }
      return
    }
    if (frame.kind === 'message') {
      const txt = (frame.parts || []).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n')
      if (txt) setHistory(h => [...h, { role: frame.role, text: txt }])
      return
    }
  }

  async function send() {
    if (!text.trim()) return
    const parts: A2APart[] = [{ kind:'text', text, metadata: { 'urn:cc:a2a:v1': { finality } } }]
    // If we have a current task, this is a normal turn. Otherwise, for 'a' we start a new epoch.
    const ac = new AbortController()
    streamAbort.current?.abort()
    streamAbort.current = ac
    try {
      for await (const frame of a2a.messageStreamParts(parts, taskId, ac.signal)) {
        handleFrame(frame as any)
      }
    } catch (e) {
      // silence on close
    } finally {
      if (streamAbort.current === ac) streamAbort.current = null
      setText('')
    }
  }

  async function softReset() {
    if (!pairId) return
    await fetch(`/api/pairs/${pairId}/reset`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type: 'soft' }) })
  }
  async function hardReset() {
    if (!pairId) return
    await fetch(`/api/pairs/${pairId}/reset`, { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ type: 'hard' }) })
  }

  const canSend = role === (status === 'input-required' ? 'b' : 'a') || !taskId
  const roleName = role === 'a' ? 'Client (initiator)' : 'Responder (server)'

  return (
    <div className="col" style={{gap:16}}>
      <div className="card">
        <div className="row">
          <div><strong>Pair:</strong> {pairId || '(none)'} <span className="pill">{roleName}</span></div>
          <div className="pill">Status: {status}</div>
          <div style={{marginLeft:'auto'}} className="row">
            <button onClick={softReset}>Soft reset</button>
            <button onClick={hardReset} style={{borderColor:'#7b2f2f', color:'#ff9a9a'}}>Hard reset</button>
          </div>
        </div>
        {banner && <div className="muted small" style={{marginTop:8}}>{banner}</div>}
      </div>

      <div className="card">
        <div className="chat">
          {history.length === 0 && <div className="muted small">No messages yet.</div>}
          {history.map((m, i) => (
            <div key={i} className={'msg ' + m.role}>
              <div className="small muted">{m.role === 'agent' ? 'From other side' : 'You'}</div>
              <div>{m.text}</div>
            </div>
          ))}
        </div>
        <div className="row" style={{marginTop:12}}>
          <input style={{flex:1}} value={text} placeholder="Type a message..." onChange={e => setText(e.target.value)} />
          <select value={finality} onChange={e => setFinality(e.target.value as any)}>
            <option value="none">no finality</option>
            <option value="turn">end turn → flip</option>
            <option value="conversation">end conversation</option>
          </select>
          <button onClick={send} disabled={!canSend}>Send</button>
        </div>
        <div className="small muted" style={{marginTop:8}}>
          {(!taskId) ? 'No task yet — first send will create a new epoch (client only).' :
            (canSend ? 'You may send now.' : 'Waiting for the other side to end their turn.')}
        </div>
      </div>

      <div className="card small muted">
        <div><strong>How to use</strong></div>
        <ol>
          <li>Create a pair on the Control page. Open two tabs: client (role=a) and responder (role=b).</li>
          <li>Type a message on the client tab and choose finality=turn to pass the token.</li>
          <li>The responder receives the message; they can then reply and flip the turn.</li>
          <li>Use <em>Soft reset</em> to start a new epoch. Only the responder listens to the backchannel and re-subscribes automatically. The client remains a pure A2A app.</li>
        </ol>
      </div>
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
