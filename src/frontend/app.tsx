import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { A2APart, A2ATask, A2AStatus, A2AStatusUpdate } from '../shared/a2a-types'
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

type FrameResult = A2ATask | A2AStatusUpdate | { kind:'message'; role:'user'|'agent'; parts:any[] };
async function* sseToObjects(stream: ReadableStream<Uint8Array>): AsyncGenerator<FrameResult> {
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
          try { const obj = JSON.parse(data); if (obj && 'result' in obj) yield (obj.result as FrameResult) } catch { /* ignore */ }
        }
      }
    }
  }
}

type Role = 'initiator'|'responder'

function useQuery() {
  const u = new URL(window.location.href)
  const role = (u.searchParams.get('role') === 'responder') ? 'responder' : 'initiator'
  const a2aUrl = u.searchParams.get('a2a') || ''
  const tasksUrl = u.searchParams.get('tasks') || ''
  return { role, a2aUrl, tasksUrl }
}

function App() {
  const { role, a2aUrl, tasksUrl } = useQuery()
  const [status, setStatus] = useState<A2AStatus | 'initializing'>('initializing')
  const [taskId, setTaskId] = useState<string | undefined>()
  const [history, setHistory] = useState<Array<{ role:'user'|'agent', text:string }>>([])
  const [text, setText] = useState('')
  const [finality, setFinality] = useState<'none'|'turn'|'conversation'>('turn')
  const [banner, setBanner] = useState<string>('')
  const endpoint = useMemo(() => a2aUrl, [a2aUrl])
  const a2aClient = useMemo(() => new A2AClient(endpoint), [endpoint])
  const resubAbort = useRef<AbortController | null>(null)
  const streamAbort = useRef<AbortController | null>(null)

  useEffect(() => {
    if (!endpoint) return
    if (role === 'responder' && tasksUrl) {
      // responder-only backchannel
      const es = new EventSource(tasksUrl)
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
                for await (const frame of a2aClient.tasksResubscribe(msg.taskId, ac.signal)) {
                  handleFrame(frame)
                }
              } catch {}
            })()
          } else if (msg.type === 'unsubscribe') {
            setBanner('Unsubscribed (reset) — waiting for next task...')
            setHistory([]); setTaskId(undefined); setStatus('initializing')
          } else if (msg.type === 'redirect') {
            setBanner(`Hard reset — new links ready: Initiator ${msg.newPair.initiatorJoinUrl} | Responder ${msg.newPair.responderJoinUrl}`)
          }
        } catch (e) {
          console.error('Bad server-event payload', ev.data, e)
        }
      }
      es.onerror = () => setBanner('Backchannel disconnected — reconnecting...')
      return () => { try { es.close() } catch {} }
    }
  }, [endpoint, tasksUrl, role, a2aClient])

  function handleFrame(frame: FrameResult) {
    if (!frame) return
    if (frame.kind === 'task') {
      setTaskId(frame.id)
      setStatus(frame.status?.state || 'submitted')
      const msgs = (frame.history || []).map((m:any) => ({ role: m.role, text: (m.parts||[]).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n') }))
      // Include the latest message from status.message (server excludes it from history)
      const latestText = (frame.status?.message?.parts || []).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n')
      const latestRole = frame.status?.message?.role
      const merged = latestText ? [...msgs, { role: latestRole, text: latestText }] : msgs
      setHistory(merged)
      return
    }
    if (frame.kind === 'status-update') {
      const newState = frame.status?.state || 'submitted'
      setStatus(newState)
      if (newState === 'canceled' && role === 'initiator') {
        // Clear task so next send starts a new epoch
        setTaskId(undefined)
      }
      const m = frame.status?.message
      if (m) {
        const txt = (m.parts || []).filter((p:any)=>p.kind==='text').map((p:any)=>p.text).join('\n')
        if (txt) setHistory(h => [...h, { role: m.role, text: txt }])
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
    const parts: A2APart[] = [{ kind:'text', text, metadata: { 'https://chitchat.fhir.me/a2a-ext': { finality } } }]
    // If we have a current task, this is a normal turn. Otherwise, for the initiator we start a new epoch.
    const ac = new AbortController()
    streamAbort.current?.abort()
    streamAbort.current = ac
    const previousText = text
    setText('')
    try {
      for await (const frame of a2aClient.messageStreamParts(parts, taskId, ac.signal)) {
        handleFrame(frame)
      }
    } catch (e) {
      // silence on close
      // restore input if the send failed synchronously
      try { setText(previousText) } catch {}
    } finally {
      if (streamAbort.current === ac) streamAbort.current = null
    }
  }

  const canSend = !!endpoint && (
    status === 'input-required' ||
    (!taskId && role === 'initiator') ||
    (status === 'canceled' && role === 'initiator')
  )
  const sendLabel = status === 'canceled' && role === 'initiator' ? 'Send on new task' : 'Send'

  function clearTask() {
    // Initiator can clear a completed task to start a new one
    setHistory([])
    setTaskId(undefined)
    setStatus('initializing')
    setBanner('Cleared — ready to start a new task.')
  }

  function isTerminalState(s: A2AStatus | 'initializing') {
    return s === 'completed' || s === 'canceled' || s === 'failed' || s === 'rejected'
  }

  async function cancelTask() {
    if (!taskId) return
    try {
      await a2aClient.cancel(taskId)
      // Optimistic UI; server will also send a canceled status-update
      setBanner('Cancel requested')
    } catch (e) {
      setBanner('Cancel failed')
    }
  }
  const roleName = role === 'initiator' ? 'Initiator' : 'Responder'

  return (
    <div className="col" style={{gap:16}}>
      <div className="card">
        <div className="row">
          <div><strong>Role:</strong> <span className="pill">{roleName}</span></div>
          <div className="pill">Status: {status}</div>
          <div style={{marginLeft:'auto'}} className="row"/>
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
          <input
            style={{flex:1}}
            value={text}
            placeholder="Type a message..."
            onChange={e => setText(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (canSend) send(); } }}
            autoFocus
            tabIndex={1}
            disabled={status === 'completed' || status === 'failed' || status === 'canceled'}
          />
          <select value={finality} onChange={e => setFinality(e.target.value as 'none'|'turn'|'conversation')} tabIndex={2}
            disabled={status === 'completed' || status === 'failed' || (status === 'canceled' && role !== 'initiator')}>
            <option value="none">no finality</option>
            <option value="turn">end turn → flip</option>
            <option value="conversation">end conversation</option>
          </select>
          <button
            onClick={send}
            disabled={!canSend}
            tabIndex={3}
            style={{ opacity: canSend ? 1 : 0.5, cursor: canSend ? 'pointer' : 'not-allowed' }}
            aria-disabled={!canSend}
          >
            {sendLabel}
          </button>
          {taskId && isTerminalState(status) && (
            <button onClick={clearTask} tabIndex={4} style={{ marginLeft: 8 }}>
              Clear task
            </button>
          )}
          {taskId && !isTerminalState(status) && (
            <button onClick={cancelTask} tabIndex={5} style={{ marginLeft: 8 }}>
              Cancel task
            </button>
          )}
        </div>
        <div className="small muted" style={{marginTop:8}}>
          {!endpoint ? 'No endpoint configured — open from Control Plane links.' :
           (!taskId) ? (role === 'initiator' ? 'First send will start the conversation.' : 'Waiting for initiator to start.') :
           (status === 'completed' ? 'Conversation completed.' :
            status === 'canceled' ? 'Conversation canceled.' :
            status === 'failed' ? 'Conversation failed.' :
            (canSend ? 'You may send now.' : 'Waiting for the other side to end their turn.'))}
        </div>
      </div>

      <div className="card small muted">
        <div><strong>How to use</strong></div>
        <ol>
          <li>Create a pair on the Control page. Open two tabs using the provided links (initiator and responder).</li>
          <li>Type a message on the initiator tab and choose finality=turn to pass the token.</li>
          <li>The responder receives the message; they can then reply and flip the turn.</li>
          <li>Use <em>Soft reset</em> to start a new epoch. Only the responder listens to the backchannel and re-subscribes automatically. The initiator remains a pure A2A app.</li>
        </ol>
      </div>
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
