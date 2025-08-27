import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAppStore } from '../state/store'
import { A2AAdapter } from '../transports/a2a-adapter'
import { PlannerSetupCard } from '../participant/PlannerSetupCard'
import { DebugPanel } from '../participant/DebugPanel'
import { startPlannerController } from '../planner/controller'
import type { AttachmentMeta } from '../../shared/journal-types'
import { TaskRibbon } from '../components/TaskRibbon'
import { PlannerSelector, PlannerModeSelector } from '../components/PlannerSelectors'
import { ManualComposer } from '../components/ManualComposer'
import { Whisper } from '../components/Whisper'
import { attachmentHrefFromBase64 } from '../components/attachments'
import { useUrlPlannerSetup } from '../hooks/useUrlPlannerSetup'
import { DraftInline } from '../components/DraftInline'
import { Markdown } from '../components/Markdown'

function useRoom() {
  const url = new URL(window.location.href)
  const parts = url.pathname.split('/').filter(Boolean)
  const qp = url.searchParams.get('roomId') || ''
  const roomId = qp || parts[1] || ''
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
  const [sending, setSending] = useState(false)
  const urlSetup = useUrlPlannerSetup() as any

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
  const approved = useAppStore(s => s.composeApproved)
  const sentComposeIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const f of facts) if (f.type === 'remote_sent' && (f as any).composeId) s.add((f as any).composeId as string);
    return s;
  }, [facts])
  const observing = backendGranted === false

  function copy(s: string) { try { navigator.clipboard.writeText(s) } catch {} }

  // Actions
  async function handleManualSend(text: string, nextState: 'working'|'input-required'|'completed'|'canceled'|'failed'|'rejected'|'auth-required') {
    const composeId = useAppStore.getState().appendComposeIntent(text)
    setSending(true)
    try { await useAppStore.getState().sendCompose(composeId, nextState) }
    finally { setSending(false) }
  }
  function sendWhisper(text: string) {
    const t = text.trim(); if (!t) return;
    useAppStore.getState().addUserGuidance(t);
  }

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

      {!observing && (
        <div className="card">
          <div className="row">
            <div><strong>Role:</strong> <span className="pill">A2A Server</span></div>
            <PlannerSelector />
            <PlannerModeSelector />
          </div>
        </div>
      )}

      <TaskRibbon />
      {!observing && <PlannerSetupCard urlSetup={urlSetup} />}

      <DebugPanel />

      <div className="card">
        <div className={`transcript ${observing ? 'faded' : ''}`} aria-live="polite">
          {!facts.length && <div className="small muted">No events yet.</div>}
          {facts.map((f:any) => {
            if (f.type === 'remote_received' || f.type === 'remote_sent') {
              const isMe = f.type === 'remote_sent'
              return (
                <div key={f.id} className={'bubble ' + (isMe ? 'me' : 'them')}>
                  <div className="small muted">{isMe ? 'Our side' : 'Other side'}</div>
                  <Markdown text={f.text} />
                  {Array.isArray(f.attachments) && f.attachments.length > 0 && (
                    <div className="attachments small">
                      {f.attachments.map((a:AttachmentMeta) => {
                        const added = facts.find((x:any) => x.type === 'attachment_added' && (x as any).name === a.name)
                        const href = added && added.type === 'attachment_added' ? attachmentHrefFromBase64(a.name, (added as any).mimeType, (added as any).bytes) : null
                        return (
                          <a key={a.name} className="att" href={href || '#'} target="_blank" rel="noreferrer" onClick={e => { if (!href) e.preventDefault(); }}>
                            📎 {a.name} <span className="muted">({a.mimeType || 'application/octet-stream'})</span>
                          </a>
                        )
                      })}
                    </div>
                  )}
                </div>
              )
            }
            if (f.type === 'agent_question' || f.type === 'user_answer' || f.type === 'compose_intent' || f.type === 'user_guidance') {
              // Hide agent whispers like "Answer <qid>:" in journal view
              if (f.type === 'user_guidance') {
                const t = String((f as any).text || '')
                if (/^\s*Answer\s+[^:]+\s*:/.test(t)) return <div key={f.id} style={{display:'none'}} />
              }
              // Hide approved/sent drafts
              if (f.type === 'compose_intent' && (approved.has(f.composeId) || sentComposeIds.has(f.composeId))) return <div key={f.id} style={{display:'none'}} />
              const stripeClass =
                f.type === 'user_guidance' ? 'stripe whisper' :
                f.type === 'agent_question' ? 'stripe question' :
                f.type === 'user_answer' ? 'stripe answer' : 'stripe draft'
              const isDismissed = (f.type === 'compose_intent') && [...facts].some((x:any) => x.type === 'compose_dismissed' && (x as any).composeId === f.composeId)
              return (
                <div key={f.id} className={'private ' + stripeClass} style={isDismissed ? { opacity: 0.5 } : undefined}>
                  <div className="stripe-head">
                    {f.type === 'user_guidance' && 'Private • Whisper'}
                    {f.type === 'agent_question' && 'Private • Agent Question'}
                    {f.type === 'user_answer' && 'Private • Answer'}
                    {f.type === 'compose_intent' && (isDismissed ? 'Private • Draft (dismissed)' : 'Private • Draft')}
                  </div>
                  <div className="stripe-body">
                    {f.type === 'user_guidance' && <Markdown text={f.text} />}
                    {f.type === 'user_answer' && <Markdown text={(f as any).text} />}
                    {f.type === 'compose_intent' && (
                      observing || isDismissed
                        ? <Markdown text={f.text} />
                        : <DraftInline composeId={f.composeId} text={f.text} attachments={(f as any).attachments as AttachmentMeta[] | undefined} />
                    )}
                  </div>
                </div>
              )
            }
            return <div key={f.id} />
          })}
        </div>

        {!observing && (
          <ManualComposer
            disabled={uiStatus !== 'input-required'}
            hint={uiStatus !== 'input-required' ? 'Not your turn' : undefined}
            placeholder={uiStatus === 'input-required' ? 'Type a message to the other side…' : 'Not your turn yet…'}
            onSend={handleManualSend}
            sending={sending}
          />
        )}
      </div>

      {!observing && (
        <div className="card">
          <Whisper onSend={sendWhisper} />
        </div>
      )}
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
