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
import { DEFAULT_BANTEROP_MODEL } from '../../shared/llm-provider'
import { TopBar } from '../components/TopBar'
import { MetaBar } from '../components/MetaBar'
import { ClientSettingsModal } from '../client/ClientSettingsModal'
import { LinksCard } from './components/LinksCard'
import { deriveChatLabels } from '../components/chat-labels'
import { AutomationCard } from '../components/AutomationCard'
import { LogCard } from '../components/LogCard'
import { WireLogCard } from '../components/WireLogCard'
import { Settings, Copy } from 'lucide-react'
import { AppLayout as SharedAppLayout } from '../ui'
import { CollapsibleCard } from '../components/CollapsibleCard'

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
    // Wire logging for the room now comes from server backchannel SSE (client-wire-event),
    // so skip local A2A adapter wire logs to avoid duplicates.
    try { useAppStore.getState().wire.setMode('a2a'); } catch {}
    const adapter = new A2AAdapter(a2a, { roomId, suppressOwnFromSnapshots: false })
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
  const { usLabel, otherLabel } = React.useMemo(() => deriveChatLabels(plannerId, scenarioCfg), [plannerId, scenarioCfg])
  const plannerMode = useAppStore(s => s.plannerMode)
  const plannerReady = useAppStore(s => !!s.readyByPlanner[s.plannerId])
  const plannerConfig = useAppStore(s => s.configByPlanner[s.plannerId])
  const approved = useAppStore(s => s.composeApproved)
  const hasPublic = React.useMemo(() => facts.some(f => f.type === 'message_sent' || f.type === 'message_received'), [facts])
  const waitingForClient = (!taskId) || ((uiStatus === 'submitted' || uiStatus === 'initializing') && !hasPublic)
  const sentComposeIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const f of facts) if (f.type === 'message_sent' && (f as any).composeId) s.add((f as any).composeId as string);
    return s;
  }, [facts])
  const hasTranscript = React.useMemo(() => {
    for (const f of facts) {
      if (f.type === 'message_received' || f.type === 'message_sent') return true;
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
        // For sample client link: exclude any additional instructions from our planner config
        try {
          if (plannerId === 'scenario-v0.3' && seed && typeof seed === 'object' && 'instructions' in seed) {
            const { instructions: _omit, ...rest } = seed as any;
            seed = rest;
          }
        } catch {}
        // Choose a default LLM model for the client: prefer seed.model when present, else banterop preset
        const defaultModel = (seed && typeof seed.model === 'string' && seed.model.trim()) ? seed.model : DEFAULT_BANTEROP_MODEL
        const payload: any = {
          // Default to A2A, but include MCP URL for easy switching in client
          transport: 'a2a',
          agentCardUrl: agentCard,
          mcpUrl: mcp,
          llm: { provider: 'server', model: defaultModel },
          planner: { id: plannerId, mode: 'approve' as const },
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
      if (f.type === 'message_sent') break;
      if (f.type === 'compose_intent') {
        if (!dismissed.has(String(f.composeId||''))) return true;
      }
    }
    return false;
  }, [facts]);
  const turnText = (() => {
    if (!taskId) return 'Waiting for client';
    const hasPublic = facts.some(f => f.type === 'message_sent' || f.type === 'message_received');
    if (uiStatus === 'completed') return 'Completed';
    if (uiStatus === 'failed' || uiStatus === 'rejected') return 'Failed';
    if (uiStatus === 'canceled') return 'Canceled';
    if (pendingReview && useAppStore.getState().plannerMode === 'approve') return 'Waiting for review';
    if (uiStatus === 'input-required') return 'Our turn';
    if (uiStatus === 'working') return 'Other side working';
    if (uiStatus === 'submitted' || uiStatus==='initializing') return hasPublic ? 'Setting up…' : 'Waiting for client';
    return uiStatus || 'Unknown';
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
    <SharedAppLayout title="Banterop" fullWidth>
      {/* Subheader */}
      {(() => (
        <div className="">
          {React.createElement(require('../ui/components/PageHeader').PageHeader as any, {
            title: (
              <div className="flex items-center gap-2 min-w-0">
                <span className="truncate">Room: {roomTitleFromHash || roomId || '—'}</span>
                <span className={`pill ${isOwner ? 'bg-green-50 text-green-800' : (observing ? 'bg-amber-50 text-amber-800' : 'bg-gray-100 text-gray-800')}`}>{isOwner ? 'Connected' : (observing ? 'Observing' : 'Connecting…')}</span>
              </div>
            ),
            right: (
              <button title="Settings" aria-label="Settings" onClick={()=>setShowSettings(true)} className="p-1 ml-2 text-gray-600 hover:text-gray-900 bg-transparent border-0 row compact">
                <Settings size={18} strokeWidth={1.75} />
                <span className="hidden sm:inline text-sm">Config</span>
              </button>
            ),
            offset: 48,
            fullWidth: true,
          })}
        </div>
      ))()}
      <div className={`wrap ${showDebug ? 'with-debug' : ''}`}>

  {(() => {
    function summarizeTaskId(full?: string | null): string {
      const t = String(full || '');
      if (!t) return 'No task';
      const hashIdx = t.indexOf('#');
      if (hashIdx >= 0) return `…${t.slice(hashIdx)}`;
      return t.length > 12 ? `…${t.slice(-12)}` : t;
    }
    const chips: Array<{ text:string; tone?:'neutral'|'green'|'amber'|'blue'|'gray' }> = [];
    chips.push({ text:'A2A', tone:'gray' });
    if (taskId) {
      chips.push({ text: `Task ${summarizeTaskId(taskId)}`, tone:'gray' });
      const statusChip = (turnText === 'Our turn') ? 'Our Turn' : (turnText || '');
      if (statusChip) chips.push({ text: statusChip, tone: statusChip === 'Our Turn' ? 'blue' : 'gray' });
    }
    return (
      <MetaBar elRef={metaRef} offset={92} left={<span />} chips={chips} />
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

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-3" ref={gridRef}>
        <div className="flex flex-col gap-3 order-2 lg:order-none">
          <div className="card">
            <div className="small muted mb-1.5">Conversation</div>
            <div className={`transcript ${(observing || isFinal) ? 'faded' : ''}`} aria-live="polite" ref={transcriptRef}>
            {facts.map((f:any) => {
            if (f.type === 'message_received' || f.type === 'message_sent') {
              const isMe = f.type === 'message_sent'
              const who = isMe ? usLabel : otherLabel
              const ts = (f as any).ts;
              const d = typeof ts === 'string' ? new Date(ts) : null;
              const time = (d && !isNaN(d.getTime())) ? d.toLocaleTimeString() : '';
              return (
                <div key={f.id} className={'bubble ' + (isMe ? 'me' : 'them')}>
                  <div className="row items-center small muted mb-1">
                    <span className={`pill ${isMe ? 'bg-primary-100 text-primary-800' : 'bg-gray-100 text-gray-800'}`}>{who}</span>
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
            if (f.type === 'agent_question' || f.type === 'user_answer' || f.type === 'compose_intent' || f.type === 'user_guidance' || f.type === 'planner_error') {
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
                f.type === 'user_answer' ? 'stripe answer' :
                f.type === 'planner_error' ? 'stripe whisper' :
                'stripe draft'
              const isDismissed = (f.type === 'compose_intent') && [...facts].some((x:any) => x.type === 'compose_dismissed' && (x as any).composeId === f.composeId)
              return (
                <div key={f.id} className={'private ' + stripeClass + (isDismissed ? ' opacity-50' : '')}>
                  <div className="stripe-head">
                    {f.type === 'user_guidance' && 'Private • Whisper'}
                    {f.type === 'agent_question' && 'Private • Agent Question'}
                    {f.type === 'user_answer' && 'Private • Answer'}
                    {f.type === 'compose_intent' && (isDismissed ? 'Private • Draft (dismissed)' : 'Private • Draft')}
                    {f.type === 'planner_error' && 'Private • Error'}
                  </div>
                  <div className="stripe-body">
                    {f.type === 'user_guidance' && <Markdown text={f.text} />}
                    {f.type === 'user_answer' && <Markdown text={(f as any).text} />}
                    {f.type === 'planner_error' && (
                      <div className="text small">
                        <span className="pill bg-red-100 text-red-800 mr-2">{(f as any).code}</span>
                        <span>{(f as any).message}</span>
                      </div>
                    )}
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
          className="side-panel order-1 lg:order-none"
          style={{
            position: fixedSide ? 'sticky' as const : 'static' as const,
            top: fixedSide ? sideTop : undefined,
            maxHeight: fixedSide ? `calc(100vh - ${sideTop}px)` : undefined,
            overflowY: fixedSide ? 'auto' : undefined,
          }}
        >
          <div className="flex flex-col gap-3 min-h-0">
            <CollapsibleCard title="Helpful Links" initialOpen>
              <LinksCard
                agentCard={agentCard}
                mcpUrl={mcp}
                onCopyAgent={copyCard}
                onCopyMcp={copyMcp}
                copiedAgent={copiedCard}
                copiedMcp={copiedMcp}
                clientHref={clientHref}
                historyHref={`/rooms/${encodeURIComponent(roomId)}/history`}
                ctaPrimary={waitingForClient}
                hideTitle
              />
            </CollapsibleCard>

            <CollapsibleCard title="Automation" initialOpen>
              <AutomationCard bare hideTitle
                mode={plannerMode as any}
                onModeChange={(m)=>useAppStore.getState().setPlannerMode(m)}
                plannerSelect={<PlannerSelector />}
              />
            </CollapsibleCard>

            <CollapsibleCard title="Wire Messages" initialOpen>
              <WireLogCard bare max={30} />
            </CollapsibleCard>

            <CollapsibleCard title="Planner Journal" initialOpen>
              <LogCard bare rows={facts.slice(-100) as any} all={facts as any} fill={fixedSide} />
            </CollapsibleCard>
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
        onSave={(next)=>{
          // Mirror non-secret settings in sessionStorage for legacy readers
          try { window.sessionStorage.setItem('clientSettings', JSON.stringify(next)); } catch {}
          // Persist API key to localStorage (if provided)
          try {
            const key = (next.llm?.provider === 'client-openai') ? (next.llm?.apiKey || '') : '';
            if (key) localStorage.setItem('client.llm.apiKey', key);
            else localStorage.removeItem('client.llm.apiKey');
          } catch {}
          setShowSettings(false);
        }}
        serverModels={useAppStore.getState().catalogs.llmModels}
        variant="rooms"
      />
      </div>
    </SharedAppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<App />)
