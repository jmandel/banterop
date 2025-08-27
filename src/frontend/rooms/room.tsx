import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAppStore } from '../state/store'
import { A2AAdapter } from '../transports/a2a-adapter'
import { PlannerSetupCard } from '../participant/PlannerSetupCard'
import { DebugPanel } from '../participant/DebugPanel'
import { startPlannerController } from '../planner/controller'

function useRoom() {
  const url = new URL(window.location.href)
  const parts = url.pathname.split('/').filter(Boolean)
  const roomId = parts[1] || ''
  const base = `${url.origin}`
  const a2a = `${base}/api/bridge/${roomId}/a2a`
  const tasks = `${base}/api/pairs/${roomId}/server-events?mode=backend`
  const agentCard = `${base}/rooms/${roomId}/agent-card.json`
  return { roomId, a2a, tasks, agentCard }
}

function App() {
  const { roomId, a2a, tasks, agentCard } = useRoom()
  const store = useAppStore()
  const [backendGranted, setGranted] = useState<boolean | null>(null)

  useEffect(() => { document.title = `Room: ${roomId}` }, [roomId])

  // Initialize responder adapter
  useEffect(() => {
    const adapter = new A2AAdapter(a2a)
    store.init('responder' as any, adapter, undefined)
  }, [a2a])

  // Backend SSE: acquire lease, handle subscribe, set taskId
  useEffect(() => {
    const es = new EventSource(tasks)
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data)
        const msg = payload.result
        if (msg?.type === 'backend-granted') setGranted(true)
        if (msg?.type === 'backend-denied') setGranted(false)
        if (msg?.type === 'subscribe' && msg.taskId) {
          useAppStore.getState().setTaskId(String(msg.taskId))
        }
      } catch {}
    }
    es.onerror = () => {}
    return () => { try { es.close() } catch {} }
  }, [tasks])

  // Start planner controller only when lease granted
  useEffect(() => {
    if (backendGranted === true) {
      try { startPlannerController() } catch {}
    }
  }, [backendGranted])

  const roomTitle = `Room: ${roomId}`
  const taskId = useAppStore(s => s.taskId)
  const uiStatus = useAppStore(s => s.uiStatus())
  const facts = useAppStore(s => s.facts)

  function copy(s: string) { try { navigator.clipboard.writeText(s) } catch {} }

  return (
    <div className="wrap">
      <header>
        <strong>{roomTitle}</strong>
        <span className={`chip ${backendGranted ? 'ok' : 'warn'}`}>{backendGranted ? 'Backend: Active' : (backendGranted===false ? 'Backend: Observer' : 'Backend: …')}</span>
        <button onClick={()=>copy(a2a)}>Copy A2A</button>
        <button onClick={()=>copy(agentCard)}>Copy Agent Card</button>
        <a className="btn" href={`${window.location.origin}/participant/?role=initiator&a2a=${encodeURIComponent(a2a)}`} target="_blank" rel="noreferrer">Open client (initiator)</a>
      </header>

      {backendGranted===false && (
        <div className="banner">
          Another tab already owns this room’s backend. Use Ctrl‑Shift‑A and search for “{roomTitle}” to locate it.
        </div>
      )}

      <div className="card">
        <div><strong>Status:</strong> {uiStatus}</div>
        <div className="small">Task: {taskId || '—'}</div>
      </div>

      <PlannerSetupCard urlSetup={null as any} />
      <DebugPanel />

      <div className="card">
        <div className="transcript" aria-live="polite">
          {!facts.length && <div className="small muted">No events yet.</div>}
          {facts.map((f:any) => (
            <div key={f.id} className="small">
              {f.type==='remote_sent' && <div>Our side: {f.text}</div>}
              {f.type==='remote_received' && <div>Other side: {f.text}</div>}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
