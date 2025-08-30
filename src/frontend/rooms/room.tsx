import React, { useEffect, useMemo, useRef, useState } from 'react'
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
import { resolvePlanner } from '../planner/registry'
import { DEFAULT_CHITCHAT_MODEL } from '../../shared/llm-provider'
import { TopBar } from '../components/TopBar'
import { MetaBar } from '../components/MetaBar'
import { ClientSettingsModal } from '../client/ClientSettingsModal'
import { LinksCard } from './components/LinksCard'
import { AutomationCard } from '../components/AutomationCard'
import { LogCard } from '../components/LogCard'
import { Settings, Copy } from 'lucide-react'

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
  const mcp = `${base}/api/rooms/${roomId}/mcp`
  const tasks = `${base}/api/rooms/${roomId}/server-events?mode=backend`
  const agentCard = `${base}/api/rooms/${roomId}/.well-known/agent-card.json`
  return { roomId, a2a, mcp, tasks, agentCard }
}

function App() {
  const { roomId, a2a, mcp, tasks, agentCard } = useRoom()
  const store = useAppStore()
  // legacy locals removed; use store.rooms slice instead
  const [sending, setSending] = useState(false)
  const [showDebug, setShowDebug] = useState(false)
  const [showSettings, setShowSettings] = useState(false)

  // Update document title using optional roomTitle from readable hash; always include roomId
  useEffect(() => {
    function parseRoomTitle(): string | null {
      try {
        const raw = (window.location.hash || '').replace(/^#/, '');
        if (!raw) return null;
        const candidates = [raw];
        try { candidates.push(decodeURIComponent(raw)); } catch {}
        for (const c of candidates) {
          const t = (c || '').trim();
          if (t.startsWith('{') && t.endsWith('}')) {
            const j = JSON.parse(t);
            const v = j && typeof j === 'object' ? (j as any).roomTitle : null;
            if (typeof v === 'string' && v.trim()) return v.trim();
          }
        }
      } catch {}
      return null;
    }
    function applyTitle() {
      const title = parseRoomTitle();
      document.title = title ? `Room: ${roomId} — ${title}` : `Room: ${roomId}`;
    }
    applyTitle();
    const onHash = () => { try { applyTitle() } catch {} };
    window.addEventListener('hashchange', onHash);
    return () => { window.removeEventListener('hashchange', onHash) };
  }, [roomId])
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

  // Start/store backend SSE via rooms slice
  useEffect(() => {
    const base = `${new URL(a2a).origin}/api/rooms/${encodeURIComponent(roomId)}/server-events`;
    useAppStore.getState().rooms.start(roomId, base);
    try { startPlannerController() } catch {}
  }, [roomId, a2a])

  const roomTitle = `Room: ${roomId}`
  const taskId = useAppStore(s => s.taskId)
  const uiStatus = useAppStore(s => s.uiStatus())
  const isFinal = ['completed','canceled','failed','rejected'].includes(uiStatus)
  const facts = useAppStore(s => s.facts)
  const plannerId = useAppStore(s => s.plannerId)
  const scenarioCfg = useAppStore(s => s.configByPlanner['scenario-v0.3'] as any)
  const { usLabel, otherLabel } = React.useMemo(() => {
    const defaults = { usLabel: 'Us', otherLabel: 'Other Side' };
    if (!scenarioCfg || plannerId !== 'scenario-v0.3') return defaults;
    const scen = (scenarioCfg && typeof scenarioCfg === 'object') ? (scenarioCfg as any).scenario : undefined;
    const agents = Array.isArray((scen as any)?.agents) ? (scen as any).agents : [];
    if (!agents.length) return defaults;
    const myId = typeof (scenarioCfg as any).myAgentId === 'string' ? String((scenarioCfg as any).myAgentId) : '';
    const me = agents.find((a:any) => String(a?.agentId || '') === myId) || agents[0];
    const other = agents.find((a:any) => String(a?.agentId || '') !== String(me?.agentId || '')) || agents[1];
    const nameOf = (a:any) => {
      const nm = (a && a.principal && typeof a.principal.name === 'string') ? a.principal.name.trim() : '';
      return nm || (typeof a?.agentId === 'string' ? a.agentId : '');
    };
    const uBase = nameOf(me);
    const oBase = nameOf(other);
    return {
      usLabel: (uBase ? uBase : defaults.usLabel) + ' (Us)',
      otherLabel: (oBase ? oBase : defaults.otherLabel) + ' (Remote Agent)',
    };
  }, [scenarioCfg, plannerId])
  const plannerMode = useAppStore(s => s.plannerMode)
  const plannerReady = useAppStore(s => !!s.readyByPlanner[s.plannerId])
  const plannerConfig = useAppStore(s => s.configByPlanner[s.plannerId])
  const approved = useAppStore(s => s.composeApproved)
  const sentComposeIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const f of facts) if (f.type === 'remote_sent' && (f as any).composeId) s.add((f as any).composeId as string);
    return s;
  }, [facts])
  const hasTranscript = React.useMemo(() => {
    for (const f of facts) {
      if (f.type === 'remote_received' || f.type === 'remote_sent') return true;
      if (f.type === 'agent_question' || f.type === 'user_answer') return true;
      if (f.type === 'user_guidance') {
        const t = String((f as any).text || '')
        if (!/^\s*Answer\s+[^:]+\s*:/.test(t)) return true;
      }
      if (f.type === 'compose_intent') {
        if (!(approved.has(f.composeId) || sentComposeIds.has(f.composeId))) return true;
      }
    }
    return false;
  }, [facts, approved, sentComposeIds])
  const connState2 = useAppStore(s => s.rooms.byId[roomId]?.connState)
  const isOwner = connState2 === 'connected'
  const observing = connState2 === 'observing'
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
  const clientHref = React.useMemo(() => {
    try {
      const origin = window.location.origin
      const base = `${origin}/client/`
      const planner: any = resolvePlanner(plannerId as any)
      if (plannerReady && planner) {
        let seed: any = undefined
        try { if (planner && typeof planner.dehydrate === 'function' && plannerConfig) seed = planner.dehydrate(plannerConfig) } catch {}
        // If scenario planner, flip myAgentId so sample client plays the OTHER agent
        try {
          if (plannerId === 'scenario-v0.3' && plannerConfig && (plannerConfig as any).scenario) {
            const scen = (plannerConfig as any).scenario;
            const agents = Array.isArray(scen?.agents) ? scen.agents : [];
            const myId = String((plannerConfig as any).myAgentId || (agents[0]?.agentId || ''));
            const other = agents.find((a:any) => String(a?.agentId || '') !== myId) || agents[1] || agents[0];
            const otherId = String(other?.agentId || myId);
            if (seed && typeof seed === 'object') {
              seed = { ...seed, myAgentId: otherId };
            }
          }
        } catch {}
        // Choose a default LLM model for the client: prefer seed.model when present, else chitchat preset
        const defaultModel = (seed && typeof seed.model === 'string' && seed.model.trim()) ? seed.model : DEFAULT_CHITCHAT_MODEL
        const payload: any = {
          agentCardUrl: agentCard,
          llm: { provider: 'server', model: defaultModel },
          planner: { id: plannerId, mode: plannerMode },
          ...(seed ? { planners: { [plannerId]: { seed } } } : {}),
        }
        return `${base}#${JSON.stringify(payload)}`
      }
      return `${base}#${JSON.stringify({ agentCardUrl: agentCard, planner: { id: plannerId, mode: plannerMode } })}`
    } catch { return `${window.location.origin}/client/#${JSON.stringify({ agentCardUrl: agentCard })}` }
  }, [agentCard, plannerId, plannerReady, plannerConfig, plannerMode])

  // Optional roomTitle from readable JSON hash
  const roomTitleFromHash = React.useMemo(() => {
    const raw = (window.location.hash || '').slice(1);
    const candidates = [raw];
    try { candidates.push(decodeURIComponent(raw)); } catch {}
    for (const c of candidates) {
      const s = (c || '').trim();
      if (s.startsWith('{') && s.endsWith('}')) {
        try { const j = JSON.parse(s); const t = j && j.roomTitle; if (typeof t === 'string' && t.trim()) return t.trim(); } catch {}
      }
    }
    return '';
  }, []);

  // Build task chips for MetaBar
  const pendingReview = React.useMemo(() => {
    const dismissed = new Set<string>(facts.filter((f:any)=>f.type==='compose_dismissed').map((f:any)=>String(f.composeId||'')));
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i] as any;
      if (f.type === 'remote_sent') break;
      if (f.type === 'compose_intent') {
        if (!dismissed.has(String(f.composeId||''))) return true;
      }
    }
    return false;
  }, [facts]);
  const turnChip = (() => {
    if (uiStatus === 'completed') return { text: 'Completed', tone: 'green' as const };
    if (uiStatus === 'failed' || uiStatus === 'rejected') return { text: 'Failed', tone: 'amber' as const };
    if (uiStatus === 'canceled') return { text: 'Canceled', tone: 'amber' as const };
    if (pendingReview && useAppStore.getState().plannerMode === 'approve') return { text:'Waiting for review', tone: 'amber' as const };
    if (uiStatus === 'input-required') return { text:'Our turn', tone:'amber' as const };
    if (uiStatus === 'working') return { text:'Other side working', tone:'blue' as const };
    if (uiStatus === 'submitted' || uiStatus==='initializing') return { text:'Setting up…', tone:'gray' as const };
    return { text: uiStatus || 'Unknown', tone:'gray' as const };
  })();
  // Graceful release on unload
  useEffect(() => {
    function release() { try { useAppStore.getState().rooms.release(roomId) } catch {} }
    window.addEventListener('beforeunload', release)
    return () => { window.removeEventListener('beforeunload', release) }
  }, [roomId])

  // takeover handled by store slice

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

  // Fixed sidebar on large screens: compute left position and dynamic top under sticky bars
  const gridRef = React.useRef<HTMLDivElement|null>(null)
  const metaRef = React.useRef<HTMLDivElement|null>(null)
  const [fixedSide, setFixedSide] = useState(false)
  const [sideLeft, setSideLeft] = useState<number | null>(null)
  const [sideTop, setSideTop] = useState<number>(96)
  useEffect(() => {
    function recalc() {
      const isWide = window.innerWidth >= 1024; // ~tailwind lg breakpoint
      setFixedSide(isWide)
      const r = gridRef.current?.getBoundingClientRect()
      if (isWide && r) setSideLeft(Math.round(r.right - 340))
      else setSideLeft(null)
      // measure bottom of MetaBar to avoid occlusion
      const m = metaRef.current?.getBoundingClientRect();
      if (m) setSideTop(Math.max(0, Math.round(m.bottom + 8)))
    }
    recalc();
    window.addEventListener('resize', recalc)
    window.addEventListener('scroll', recalc, { passive: true } as any)
    window.addEventListener('load', recalc)
    return () => { window.removeEventListener('resize', recalc); window.removeEventListener('scroll', recalc as any); window.removeEventListener('load', recalc) }
  }, [])

  return (
    <div className={`wrap ${showDebug ? 'with-debug' : ''}`}>
      <TopBar
        left={(
          <div className="row compact" style={{ alignItems:'baseline', gap: 8 }}>
            <span className="small muted">Room</span>
            <span className="text-sm font-semibold">{roomTitleFromHash || roomId || '—'}</span>
            <span className={`pill ${isOwner ? 'ok' : (observing ? 'warn' : 'info')}`}>{isOwner ? 'Connected' : (observing ? 'Observing only' : 'Connecting…')}</span>
          </div>
        )}
        right={(
          <button
            title="Settings"
            aria-label="Settings"
            onClick={()=>setShowSettings(true)}
            className="p-1 ml-2 text-gray-600 hover:text-gray-900 bg-transparent border-0 row compact"
          >
            <Settings size={18} strokeWidth={1.75} />
            <span className="text-sm">Config</span>
          </button>
        )}
      />

  {(() => {
    function summarizeTaskId(full?: string | null): string {
      const t = String(full || '');
      if (!t) return 'No task';
      const hashIdx = t.indexOf('#');
      if (hashIdx >= 0) return `…${t.slice(hashIdx)}`;
      return t.length > 12 ? `…${t.slice(-12)}` : t;
    }
    return (
      <MetaBar
        elRef={metaRef}
        left={(
          <div className="row compact">
            <span className="small muted">Task</span>
            <span className="pill">{summarizeTaskId(taskId)}</span>
            {!!taskId && (
              <button
                className="p-1 rounded hover:bg-gray-100 text-gray-600"
                title="Copy Task ID"
                aria-label="Copy Task ID"
                onClick={() => { try { navigator.clipboard.writeText(taskId) } catch {} }}
              >
                <Copy size={16} strokeWidth={1.75} />
              </button>
            )}
          </div>
        )}
        chips={[turnChip]}
      />
    );
  })()}

      {observing && (
        <div className="banner">
          Another tab is currently controlling this room’s backend.
          <span className="small" style={{ marginLeft: 8 }}>
            Tip: use Ctrl‑Shift‑A (or Cmd‑Shift‑A on macOS) and search for the room ID “{roomId}”.{roomTitleFromHash ? ` (You can also try the title “${roomTitleFromHash}”.)` : ''}
          </span>
          <button className="btn secondary" style={{ marginLeft: 10 }} onClick={()=>useAppStore.getState().rooms.takeover(roomId)}>Force take over</button>
        </div>
      )}

      {showDebug && <DebugPanel />}

      <div className="grid grid-cols-[1fr_340px] gap-3" ref={gridRef}>
        <div className="flex flex-col gap-3">
          <div className="card">
            <div className="small muted mb-1.5">Conversation</div>
            <div className={`transcript ${(observing || isFinal) ? 'faded' : ''}`} aria-live="polite" ref={transcriptRef}>
            {facts.map((f:any) => {
            if (f.type === 'remote_received' || f.type === 'remote_sent') {
              const isMe = f.type === 'remote_sent'
              const who = isMe ? usLabel : otherLabel
              const ts = (f as any).ts;
              const d = typeof ts === 'string' ? new Date(ts) : null;
              const time = (d && !isNaN(d.getTime())) ? d.toLocaleTimeString() : '';
              return (
                <div key={f.id} className={'bubble ' + (isMe ? 'me' : 'them')}>
                  <div className="row items-center small muted mb-1">
                    <span className={`pill ${isMe ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-800'}`}>{who}</span>
                    <span className="muted">{time}</span>
                  </div>
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
                if (/^\s*Answer\s+[^:]+\s*:/.test(t)) return <div key={f.id} className="hidden" />
              }
              // Hide approved/sent drafts
              if (f.type === 'compose_intent' && (approved.has(f.composeId) || sentComposeIds.has(f.composeId))) return <div key={f.id} className="hidden" />
              const stripeClass =
                f.type === 'user_guidance' ? 'stripe whisper' :
                f.type === 'agent_question' ? 'stripe question' :
                f.type === 'user_answer' ? 'stripe answer' : 'stripe draft'
              const isDismissed = (f.type === 'compose_intent') && [...facts].some((x:any) => x.type === 'compose_dismissed' && (x as any).composeId === f.composeId)
              return (
                <div key={f.id} className={'private ' + stripeClass + (isDismissed ? ' opacity-50' : '')}>
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
                        : <DraftInline composeId={f.composeId} text={f.text} attachments={(f as any).attachments as AttachmentMeta[] | undefined} nextStateHint={(f as any).nextStateHint as any} />
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
          </div>
          {!observing && plannerId === 'off' && !isFinal && (
            <ManualComposer
              disabled={uiStatus !== 'input-required'}
              hint={uiStatus !== 'input-required' ? 'Not your turn' : undefined}
              placeholder={uiStatus === 'input-required' ? 'Type a message to the other side…' : 'Not your turn yet…'}
              onSend={handleManualSend}
              sending={sending}
            />
          )}
          {!observing && <PlannerSetupCard />}
        </div>

        <div
          className={(fixedSide ? 'flex flex-col gap-3' : 'sticky top-24 overflow-y-auto')}
          style={fixedSide ? { position:'fixed', left: (sideLeft ?? 0), top: sideTop, width: 340, height: `calc(100vh - ${sideTop}px)`, overflow: 'hidden', minHeight: 0 } : { maxHeight: 'calc(100vh - 96px)' }}
        >
          <div className="flex flex-col gap-3 min-h-0 h-full">
            <LinksCard
              agentCard={agentCard}
              mcpUrl={mcp}
              onCopyAgent={copyCard}
              onCopyMcp={copyMcp}
              copiedAgent={copiedCard}
              copiedMcp={copiedMcp}
              clientHref={clientHref}
            />

            <AutomationCard
              mode={plannerMode as any}
              onModeChange={(m)=>useAppStore.getState().setPlannerMode(m)}
              plannerSelect={<PlannerSelector />}
            />

            <LogCard rows={facts.slice(-100) as any} all={facts as any} fill />
          </div>
        </div>
      </div>

      {!observing && (
        <div className="card" style={{ display: 'none' }}>
          <Whisper onSend={sendWhisper} />
        </div>
      )}

      <ClientSettingsModal
        open={showSettings}
        value={(() => {
          try { const raw = window.sessionStorage.getItem('clientSettings'); return raw ? JSON.parse(raw) : { transport:'a2a', a2aCardUrl:'', mcpUrl:'', llm:{ provider:'server', model:'' } } } catch { return { transport:'a2a', a2aCardUrl:'', mcpUrl:'', llm:{ provider:'server', model:'' } } }
        })()}
        onCancel={()=>setShowSettings(false)}
        onSave={(next)=>{ try { window.sessionStorage.setItem('clientSettings', JSON.stringify(next)); } catch {}; setShowSettings(false); }}
        serverModels={useAppStore.getState().catalogs.llmModels}
        variant="rooms"
      />
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
