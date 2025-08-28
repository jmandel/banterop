import React, { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { useAppStore } from '../state/store'
import { A2AAdapter } from '../transports/a2a-adapter'
import { PlannerSetupCard } from '../client/PlannerSetupCard'
import { DebugPanel } from '../client/DebugPanel'
import { startPlannerController } from '../planner/controller'
import type { AttachmentMeta } from '../../shared/journal-types'
import type { A2ANextState } from '../../shared/a2a-types'
import { TaskRibbon } from '../components/TaskRibbon'
import { PlannerSelector, PlannerModeSelector } from '../components/PlannerSelectors'
import { ManualComposer } from '../components/ManualComposer'
import { Whisper } from '../components/Whisper'
import { attachmentHrefFromBase64 } from '../components/attachments'
import { startUrlSync } from '../hooks/startUrlSync'
import { DraftInline } from '../components/DraftInline'
import { Markdown } from '../components/Markdown'

// EXPERIMENTAL: WebRTC datachannel keepalive to avoid Chrome Energy Saver freezing
// See: https://developer.chrome.com/blog/freezing-on-energy-saver
async function startExperimentalRtcKeepAlive(): Promise<() => void> {
  const url = new URL(window.location.href)
  const qp = (k:string) => String(url.searchParams.get(k) || '')
  // Enable by default; allow opt-out via ?expRtcKeepAlive=0|false
  const enabled = (() => { const v = qp('expRtcKeepAlive'); return !v || !['0','false','off','no'].includes(v.toLowerCase()) })()
  if (!enabled) return () => {}
  try { console.debug('[rooms] EXP: starting RTC keepalive (experimental)') } catch {}
  let ping: any = null
  const a = new RTCPeerConnection()
  const b = new RTCPeerConnection()
  const cleanup = () => { try { clearInterval(ping) } catch {}; try { a.close() } catch {}; try { b.close() } catch {} }
  try {
    const dc = a.createDataChannel('keepalive')
    b.ondatachannel = (e) => { const rx = e.channel; rx.onmessage = () => {} }
    const offer = await a.createOffer()
    await a.setLocalDescription(offer)
    await b.setRemoteDescription(offer)
    const answer = await b.createAnswer()
    await b.setLocalDescription(answer)
    await a.setRemoteDescription(answer)
    dc.onopen = () => {
      try { console.debug('[rooms] EXP: RTC datachannel open; sending ping every 10s') } catch {}
      ping = setInterval(() => { try { if (dc.readyState === 'open') dc.send('ping') } catch {} }, 10_000)
    }
    dc.onclose = () => { try { console.debug('[rooms] EXP: RTC datachannel closed') } catch {} }
    // Page Lifecycle logging for visibility
    const onFreeze = () => { try { console.debug('[rooms] EXP: Page freeze event') } catch {} }
    const onResume = () => { try { console.debug('[rooms] EXP: Page resume event') } catch {} }
    try { (document as any).addEventListener?.('freeze', onFreeze) } catch {}
    try { (document as any).addEventListener?.('resume', onResume) } catch {}
    return () => { try { (document as any).removeEventListener?.('freeze', onFreeze) } catch {}; try { (document as any).removeEventListener?.('resume', onResume) } catch {}; cleanup() }
  } catch (e) {
    try { console.warn('[rooms] EXP: RTC keepalive failed:', (e as any)?.message || e) } catch {}
    cleanup();
    return () => {}
  }
}

function useRoom() {
  const url = new URL(window.location.href)
  const parts = url.pathname.split('/').filter(Boolean)
  const qp = url.searchParams.get('roomId') || ''
  const roomId = qp || parts[1] || ''
  const base = `${url.origin}`
  const a2a = `${base}/api/rooms/${roomId}/a2a`
  const mcp = `${base}/api/bridge/${roomId}/mcp`
  const tasks = `${base}/api/pairs/${roomId}/server-events?mode=backend`
  const agentCard = `${base}/rooms/${roomId}/agent-card.json`
  return { roomId, a2a, mcp, tasks, agentCard }
}

function App() {
  const { roomId, a2a, mcp, tasks, agentCard } = useRoom()
  const store = useAppStore()
  const [backendGranted, setGranted] = useState<boolean | null>(null)
  const [leaseId, setLeaseId] = useState<string | null>(null)
  const [esUrl, setEsUrl] = useState<string>(tasks)
  const [sending, setSending] = useState(false)
  const [showDebug, setShowDebug] = useState(false)

  useEffect(() => { document.title = `Room: ${roomId}` }, [roomId])
  // Start URL sync so deep-links hydrate configs and maintain hash
  useEffect(() => { try { startUrlSync() } catch {} }, [])

  // Experimental: start RTC-based keepalive on mount (opt-out via ?expRtcKeepAlive=0)
  useEffect(() => { let stop: (()=>void)|null = null; (async()=>{ try { stop = await startExperimentalRtcKeepAlive() } catch {} })(); return () => { try { stop && stop() } catch {} } }, [])

  // Initialize responder adapter
  useEffect(() => {
    const adapter = new A2AAdapter(a2a)
    store.init('responder' as any, adapter, undefined)
    // Store adapter on window for debug and lease updates
    ;(window as any).__a2aAdapter = adapter
  }, [a2a])

  // Backend SSE: acquire lease, handle subscribe, set taskId
  useEffect(() => {
    const es = new EventSource(esUrl)
    es.onmessage = (ev) => {
      try {
        const payload = JSON.parse(ev.data)
        const msg = payload.result
        if (msg?.type === 'backend-granted') {
          setGranted(true)
          if (msg.leaseId) setLeaseId(String(msg.leaseId))
          try { ((window as any).__a2aAdapter as A2AAdapter | undefined)?.setBackendLease(String(msg.leaseId||'')) } catch {}
        }
        if (msg?.type === 'backend-denied') setGranted(false)
        if (msg?.type === 'backend-revoked') {
          setGranted(false)
          setLeaseId(null)
          try { ((window as any).__a2aAdapter as A2AAdapter | undefined)?.setBackendLease(null) } catch {}
        }
        if (msg?.type === 'subscribe' && msg.taskId) {
          useAppStore.getState().setTaskId(String(msg.taskId))
        }
      } catch {}
    }
    es.onerror = () => {}
    return () => { try { es.close() } catch {} }
  }, [esUrl])

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
  const plannerId = useAppStore(s => s.plannerId)
  const approved = useAppStore(s => s.composeApproved)
  const sentComposeIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const f of facts) if (f.type === 'remote_sent' && (f as any).composeId) s.add((f as any).composeId as string);
    return s;
  }, [facts])
  const observing = backendGranted === false
  const [autoScroll, setAutoScroll] = useState(true)
  const transcriptRef = React.useRef<HTMLDivElement|null>(null)
  React.useLayoutEffect(() => {
    if (!autoScroll) return;
    try { window.scrollTo(0, document.documentElement.scrollHeight) } catch {}
  }, [facts, autoScroll])
  useEffect(() => {
    function onScroll() {
      const doc = document.documentElement
      const atBottom = (window.innerHeight + window.scrollY) >= (doc.scrollHeight - 8)
      if (atBottom) { if (!autoScroll) setAutoScroll(true) }
      else { if (autoScroll) setAutoScroll(false) }
    }
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => { window.removeEventListener('scroll', onScroll) }
  }, [autoScroll])

  const [copiedCard, setCopiedCard] = useState(false)
  const [copiedMcp, setCopiedMcp] = useState(false)
  async function copyCard() {
    try { await navigator.clipboard.writeText(agentCard); setCopiedCard(true); setTimeout(()=>setCopiedCard(false), 500); } catch {}
  }
  async function copyMcp() {
    try { await navigator.clipboard.writeText(mcp); setCopiedMcp(true); setTimeout(()=>setCopiedMcp(false), 500); } catch {}
  }
  // Graceful release on unload only (allow background operation; do not release on hidden)
  useEffect(() => {
    function release() {
      if (!leaseId) return;
      try {
        const u = new URL(window.location.origin)
        const rel = `${u.origin}/api/pairs/${encodeURIComponent(roomId)}/backend/release`
        const fd = new FormData(); fd.set('leaseId', leaseId)
        navigator.sendBeacon(rel, fd)
      } catch {}
    }
    window.addEventListener('beforeunload', release)
    return () => { window.removeEventListener('beforeunload', release) }
  }, [leaseId, roomId])

  function forceTakeover() {
    try { ((window as any).__a2aAdapter as A2AAdapter | undefined)?.setBackendLease(null) } catch {}
    setLeaseId(null)
    setEsUrl(`${tasks}${tasks.includes('?') ? '&' : '?'}mode=backend&takeover=1`)
  }

  // Actions
  async function handleManualSend(text: string, nextState: A2ANextState) {
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
    <div className={`wrap ${showDebug ? 'with-debug' : ''}`}>
      <header>
        <strong>{roomTitle}</strong>
        <span className={`chip ${backendGranted ? 'ok' : 'warn'}`}>{backendGranted ? 'This tab is controlling the server' : (backendGranted===false ? 'Observing the room' : 'Connecting…')}</span>
        <button className="btn ghost" onClick={copyCard}>
          <span className={`label-stack ${copiedCard ? 'show-copied' : ''}`}>
            <span className="default">Copy Agent Card URL</span>
            <span className="copied">Copied!</span>
          </span>
        </button>
        <button className="btn ghost" onClick={copyMcp}>
          <span className={`label-stack ${copiedMcp ? 'show-copied' : ''}`}>
            <span className="default">Copy MCP URL</span>
            <span className="copied">Copied!</span>
          </span>
        </button>
        <a className="btn" href={`${window.location.origin}/client/?agentCardUrl=${encodeURIComponent(agentCard)}`} target="_blank" rel="noreferrer">Open client</a>
      </header>

      {backendGranted===false && (
        <div className="banner">
          Another tab already owns this room’s backend. Use Ctrl‑Shift‑A and search for “{roomTitle}” to locate it.
          <button className="btn" style={{ marginLeft: 10 }} onClick={forceTakeover}>Force take over</button>
        </div>
      )}

      <div className="card compact sticky" style={{ top: 0 }}>
        <div className="row compact">
          <div><strong>Role:</strong> <span className="pill">A2A Server</span></div>
          {!observing && <PlannerSelector />}
          {!observing && <PlannerModeSelector />}
          <label className="small" style={{marginLeft:'auto'}}>
            <input type="checkbox" checked={showDebug} onChange={(e)=>setShowDebug(e.target.checked)} /> Show debug
          </label>
        </div>
      </div>

      <div className="sticky" style={{ top: 48 }}>
        <TaskRibbon />
      </div>
      {!observing && <PlannerSetupCard />}

      {showDebug && <DebugPanel />}

      <div className="card">
        <div className={`transcript ${observing ? 'faded' : ''}`} aria-live="polite" ref={transcriptRef}>
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
        {(observing || plannerId !== 'off') && (
          <div className="transcript-bar">
            <label className="small"><input type="checkbox" checked={autoScroll} onChange={(e)=>setAutoScroll(e.target.checked)} /> Auto scroll</label>
          </div>
        )}

        {!observing && plannerId === 'off' && (
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
