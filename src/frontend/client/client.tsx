import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AttachmentMeta } from '../../shared/journal-types';
import type { A2ANextState } from '../../shared/a2a-types';
import { useAppStore } from '../state/store';
import { A2AAdapter } from '../transports/a2a-adapter';
import { statusLabel } from '../components/status-labels';
import { MCPAdapter } from '../transports/mcp-adapter';
import { startPlannerController } from '../planner/controller';
import { resolvePlanner } from '../planner/registry';
import { makeBanteropProvider, DEFAULT_BANTEROP_ENDPOINT, DEFAULT_BANTEROP_MODEL } from '../../shared/llm-provider';
import { b64ToUtf8, normalizeB64 } from '../../shared/codec';
import { startUrlSync, updateReadableHashFromStore } from '../hooks/startUrlSync';
import { PlannerSetupCard } from './PlannerSetupCard';
import { DebugPanel } from './DebugPanel';
import { TaskRibbon } from '../components/TaskRibbon';
import { PlannerSelector, PlannerModeSelector } from '../components/PlannerSelectors';
import { ManualComposer } from '../components/ManualComposer';
import { Whisper } from '../components/Whisper';
import { DraftInline } from '../components/DraftInline';
import { Markdown } from '../components/Markdown';
import { attachmentHrefFromBase64 } from '../components/attachments';
import { ClientSettingsModal } from './ClientSettingsModal';
import { AutomationCard } from '../components/AutomationCard';
import { LogCard } from '../components/LogCard';
import { WireLogCard } from '../components/WireLogCard';
import { CollapsibleCard } from '../components/CollapsibleCard';
import { MetaBar } from '../components/MetaBar';
import { Settings } from 'lucide-react';
import { Copy } from 'lucide-react';
import { AppLayout as SharedAppLayout } from '../ui';
import { deriveChatLabels } from '../components/chat-labels';

function pickA2AEndpointFromCard(card: any, cardUrl: string): string {
  const candidates = [
    card?.url,                  // { "url": "https://..." }
    card?.a2a?.url,             // { "a2a": { "url": "..." } }
    card?.endpoints?.a2a,       // { "endpoints": { "a2a": "..." } }
    card?.endpoint,             // { "endpoint": "..." }
  ].filter((v) => typeof v === 'string' && String(v).trim());

  if (!candidates.length) return '';

  try {
    return new URL(candidates[0] as string, cardUrl).toString();
  } catch {
    return String(candidates[0]);
  }
}

function useQuery() {
  const u = new URL(window.location.href);
  // Prefer new names; fall back to legacy for backward-compat
  const cardUrl = u.searchParams.get('agentCardUrl') || u.searchParams.get('card') || '';
  const mcpUrl = u.searchParams.get('mcpUrl') || u.searchParams.get('mcp') || '';
  return { cardUrl, mcpUrl };
}

// attachmentHrefFromBase64 moved to ../components/attachments

function App() {
  const { cardUrl, mcpUrl } = useQuery();
  const store = useAppStore();
  const [sending, setSending] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [resolvedA2A, setResolvedA2A] = useState<string>('');
  const [resolvedMcp, setResolvedMcp] = useState<string>('');
  const [cardError, setCardError] = useState<string | null>(null);

  type ClientSettings = {
    transport: 'a2a'|'mcp';
    a2aCardUrl: string;
    mcpUrl: string;
    llm: { provider: 'server'|'client-openai'; model: string; baseUrl?: string; apiKey?: string };
  };

  function loadClientSettings(): ClientSettings {
    // Try to boot from readable JSON hash first
    // Preserve any existing API key in session when reading from hash
    let existingApiKey: string | undefined = undefined;
    try {
      existingApiKey = localStorage.getItem('client.llm.apiKey') || '';
    } catch {}

    try {
      const rawHash = window.location.hash?.slice(1) || '';
      const candidates: string[] = [];
      const pushIf = (s?: string) => { const t = (s || '').trim(); if (t) candidates.push(t); };
      pushIf(rawHash);
      try { pushIf(decodeURIComponent(rawHash)); } catch {}
      try { pushIf(decodeURIComponent(decodeURIComponent(rawHash))); } catch {}

      for (const s of candidates) {
        const t = s.trim();
        if (!(t.startsWith('{') && t.endsWith('}'))) continue;
        let j: any = null;
        try { j = JSON.parse(t); } catch { continue; }
        if (j && typeof j === 'object') {
          const llm = j.llm || {};
          const provider = (llm.provider === 'client-openai') ? 'client-openai' : 'server';
          const model = (provider === 'client-openai')
            ? (typeof llm.model === 'string' ? llm.model.trim() : '')
            : (typeof llm.model === 'string' && llm.model.trim() ? llm.model.trim() : DEFAULT_BANTEROP_MODEL);
          const baseUrl = provider === 'client-openai' ? (llm.baseUrl || 'https://openrouter.ai/api/v1') : undefined;
          // Do NOT read apiKey from the hash; keep any existing value
          const apiKey = provider === 'client-openai' ? (existingApiKey || '') : undefined;
          const a2aCardUrl = String(j.agentCardUrl || '');
          const mcpUrl = String(j.mcpUrl || '');
          // Prefer explicit transport in hash; fallback to URL inference (prefer A2A when both present)
          const tField = (typeof j.transport === 'string') ? j.transport.trim().toLowerCase() : '';
          const transport: 'a2a'|'mcp' = (tField === 'a2a' || tField === 'mcp') ? (tField as any)
            : (a2aCardUrl ? 'a2a' : (mcpUrl ? 'mcp' as const : 'a2a'));
          const boot = { transport, a2aCardUrl, mcpUrl, llm: { provider, model, baseUrl, apiKey } } as ClientSettings;
          // Persist immediately so controller picks it up
          try { window.sessionStorage.setItem('clientSettings', JSON.stringify(boot)); } catch {}
          return boot;
        }
      }
    } catch {}
    try {
      const raw = window.sessionStorage.getItem('clientSettings');
      if (raw) return JSON.parse(raw);
    } catch {}
    if (cardUrl) return { transport: 'a2a', a2aCardUrl: cardUrl, mcpUrl: '', llm: { provider: 'server', model: DEFAULT_BANTEROP_MODEL } };
    if (mcpUrl)  return { transport: 'mcp', a2aCardUrl: '', mcpUrl, llm: { provider: 'server', model: DEFAULT_BANTEROP_MODEL } };
    return { transport: 'a2a', a2aCardUrl: '', mcpUrl: '', llm: { provider: 'server', model: DEFAULT_BANTEROP_MODEL } };
  }
  const [clientSettings, setClientSettings] = useState<ClientSettings>(loadClientSettings);
  function saveClientSettings(next: ClientSettings) {
    // Keep both URLs if provided; transport selects which to use right now
    const normalized: ClientSettings = { ...next } as ClientSettings;
    setClientSettings(normalized);
    // Persist API key to localStorage only (never to hash)
    try {
      const key = (normalized.llm.provider === 'client-openai') ? (normalized.llm.apiKey || '') : '';
      if (key) localStorage.setItem('client.llm.apiKey', key);
      else localStorage.removeItem('client.llm.apiKey');
    } catch {}
    // Keep non-secret settings mirrored in sessionStorage for legacy readers (planner controller, rooms modal)
    try { window.sessionStorage.setItem('clientSettings', JSON.stringify(normalized)); } catch {}
    try { updateReadableHashFromStore(); } catch {}
  }

  // Start centralized URL sync
  useEffect(() => { startUrlSync(); }, []);


  // Resolve endpoints from settings (if A2A, fetch Agent Card)
  useEffect(() => {
    let cancelled = false;
    async function resolveCard() {
      setCardError(null);
      setResolvedA2A('');
      setResolvedMcp('');
      if (clientSettings.transport === 'mcp') {
        const m = (clientSettings.mcpUrl || '').trim();
        try { console.debug('[client] MCP URL (from settings/hash)', { url: m }); } catch {}
        setResolvedMcp(m);
        return;
      }

      const url = (clientSettings.a2aCardUrl || '').trim();
      if (!url) { try { console.debug('[client] No agent-card URL present'); } catch {} return; }

      try {
        try { console.debug('[client] Fetching agent-card…', { url }); } catch {}
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) throw new Error(`fetch card failed: ${res.status}`);
        const card = await res.json();
        if (cancelled) return;

        const endpoint = pickA2AEndpointFromCard(card, url);
        try { console.debug('[client] Agent-card fetched', { endpoint, cardPreview: Object.keys(card || {}) }); } catch {}

        if (!endpoint) {
          setCardError('Agent card missing a usable A2A URL (fields tried: url, a2a.url, endpoints.a2a, endpoint)');
          return;
        }
        setResolvedA2A(endpoint);
      } catch (e:any) {
        const msg = String(e?.message || 'Failed to load Agent Card');
        try { console.debug('[client] Agent-card error', { url, error: msg }); } catch {}
        setCardError(msg);
      }
    }
    resolveCard();
    return () => { cancelled = true };
  }, [clientSettings.transport, clientSettings.a2aCardUrl, clientSettings.mcpUrl]);

  // Determine transport from settings
  const transport: 'a2a'|'mcp' = clientSettings.transport;

  // init adapter once endpoints resolved
  useEffect(() => {
    const endpointA2A = resolvedA2A;
    const endpointMcp = resolvedMcp || mcpUrl;
    if (transport === 'a2a' && !endpointA2A) return;
    if (transport === 'mcp' && !endpointMcp) return;
    try { console.debug('[client] Adapter ready', { transport, endpoint: transport==='mcp' ? endpointMcp : endpointA2A }); } catch {}
    const wireSink = (e:any) => { try { useAppStore.getState().wire.add({ ...e, context: transport }); } catch {} };
    try { useAppStore.getState().wire.setMode(transport); } catch {}
    const adapter = transport === 'mcp'
      ? new MCPAdapter(endpointMcp, { onWire: wireSink })
      : new A2AAdapter(endpointA2A, { onWire: wireSink, suppressOwnFromSnapshots: true });
    store.init('initiator' as any, adapter, undefined);
    startPlannerController();
  }, [transport, resolvedA2A, resolvedMcp, mcpUrl]);

  // Load available server models for settings UI
  useEffect(() => { void store.ensureLlmModelsLoaded(); }, []);
  const serverModels = useAppStore(s => s.catalogs.llmModels);

  // No backchannel: client page is always the initiator

  const facts = useAppStore(s => s.facts);
  const taskId = useAppStore(s => s.taskId);
  const uiStatus = useAppStore(s => s.uiStatus());
  const [autoScroll, setAutoScroll] = useState(true);
  const transcriptRef = React.useRef<HTMLDivElement|null>(null);
  // Faster auto-scroll to bottom when new messages arrive
  React.useLayoutEffect(() => {
    if (!autoScroll) return;
    try { window.scrollTo(0, document.documentElement.scrollHeight); } catch {}
  }, [facts, autoScroll]);
  // Toggle autoScroll off if user scrolls up; re-enable when back at bottom
  useEffect(() => {
    function onScroll() {
      const doc = document.documentElement;
      const atBottom = (window.innerHeight + window.scrollY) >= (doc.scrollHeight - 8);
      if (atBottom) { if (!autoScroll) setAutoScroll(true); }
      else { if (autoScroll) setAutoScroll(false); }
    }
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => { window.removeEventListener('scroll', onScroll); };
  }, [autoScroll]);
  const plannerId = useAppStore(s => s.plannerId);
  const plannerConfig = useAppStore(s => s.configByPlanner[s.plannerId]);
  const { usLabel, otherLabel } = React.useMemo(() => deriveChatLabels(plannerId, plannerConfig), [plannerId, plannerConfig]);

  // Actions
  async function handleManualSend(text: string, nextState: A2ANextState) {
    const composeId = useAppStore.getState().appendComposeIntent(text);
    setSending(true);
    try { await useAppStore.getState().sendCompose(composeId, nextState); }
    finally { setSending(false); }
  }
  function sendWhisper(text: string) {
    const t = text.trim(); if (!t) return;
    useAppStore.getState().addUserGuidance(t);
  }
  async function clearTask() {
    await useAppStore.getState().cancelAndClear();
  }

  // Transcript rendering
  const approved = useAppStore(s => s.composeApproved);
  const sentComposeIds = React.useMemo(() => {
    const s = new Set<string>();
    for (const f of facts) if (f.type === 'message_sent' && (f as any).composeId) s.add((f as any).composeId as string);
    return s;
  }, [facts]);
  const hasTranscript = React.useMemo(() => {
    for (const f of facts) {
      if (f.type === 'message_received' || f.type === 'message_sent') return true;
      if (f.type === 'agent_question' || f.type === 'user_answer') return true;
      if (f.type === 'user_guidance') {
        const t = String((f as any).text || '');
        if (!/^\s*Answer\s+[^:]+\s*:/.test(t)) return true;
      }
      if (f.type === 'compose_intent') {
        if (!(approved.has(f.composeId) || sentComposeIds.has(f.composeId))) return true;
      }
    }
    return false;
  }, [facts, approved, sentComposeIds]);

  // Compute composer gating and messaging
  const initiatorCanStart = !taskId;
  const canSendManual = initiatorCanStart || uiStatus === 'input-required';
  function composerPlaceholder() {
    if (canSendManual) return 'Type a message to the other side…';
    // Terminal states: reflect exact status
    if (['completed','canceled','failed','rejected'].includes(uiStatus)) {
      return `Task ${uiStatus}.`;
    }
    if (uiStatus === 'working') return statusLabel(uiStatus);
    if (uiStatus === 'auth-required') return 'Authentication required…';
    if (uiStatus === 'unknown') return 'Waiting…';
    // Default not-your-turn message
    return 'Not our turn yet…';
  }

  // Fixed sidebar on large screens: compute left position and dynamic top under sticky bars
  const gridRef = React.useRef<HTMLDivElement|null>(null);
  const metaRef = React.useRef<HTMLDivElement|null>(null);
  const [fixedSide, setFixedSide] = useState(false);
  const [sideLeft, setSideLeft] = useState<number | null>(null);
  const [sideTop, setSideTop] = useState<number>(48);
  useEffect(() => {
    function recalc() {
      const isWide = window.innerWidth >= 1024;
      setFixedSide(isWide);
      const r = gridRef.current?.getBoundingClientRect();
      if (isWide && r) setSideLeft(Math.round(r.right - 340)); else setSideLeft(null);
      const m = metaRef.current?.getBoundingClientRect();
      if (m) setSideTop(Math.max(0, Math.round(m.bottom + 8)));
    }
    recalc();
    window.addEventListener('resize', recalc);
    window.addEventListener('scroll', recalc, { passive: true } as any);
    window.addEventListener('load', recalc);
    return () => { window.removeEventListener('resize', recalc); window.removeEventListener('scroll', recalc as any); window.removeEventListener('load', recalc); };
  }, []);

  return (
    <SharedAppLayout
      title="Banterop"
      fullWidth
      breadcrumbs={(<span className="truncate text-xl font-semibold text-gray-900">Client</span>)}
      headerRight={(
        <button title="Settings" aria-label="Settings" onClick={()=>setShowSettings(true)} className="p-1 ml-2 text-gray-600 hover:text-gray-900 bg-transparent border-0 row compact">
          <Settings size={18} strokeWidth={1.75} />
          <span className="hidden sm:inline text-sm">Config</span>
        </button>
      )}
    >
      <div className={`wrap ${showDebug ? 'with-debug' : ''}`}>
      {(() => {
        const chips: Array<{ text:string; tone?:'neutral'|'green'|'amber'|'blue'|'gray'; icon?: React.ReactNode }> = [];
        const { Network, Workflow, ClipboardList, ArrowLeftRight } = require('lucide-react');
        chips.push({ text: transport === 'mcp' ? 'MCP' : 'A2A', tone:'gray', icon: React.createElement(transport === 'mcp' ? Workflow : Network, { size:14, strokeWidth:1.75 }) });
        if (taskId) {
          chips.push({ text: `Task ${taskId}`, tone:'gray', icon: React.createElement(ClipboardList, { size:14, strokeWidth:1.75 }) });
          const dismissed = new Set<string>(facts.filter((f:any)=>f.type==='compose_dismissed').map((f:any)=>String(f.composeId||'')));
          let pendingReview = false;
          for (let i = facts.length - 1; i >= 0; --i) { const f:any = facts[i]; if (f.type==='message_sent') break; if (f.type==='compose_intent' && !dismissed.has(String(f.composeId||''))) { pendingReview = true; break; } }
          let statusText = '';
          if (['completed','canceled','failed','rejected'].includes(uiStatus)) statusText = uiStatus;
          else if (pendingReview && useAppStore.getState().plannerMode==='approve') statusText = 'Waiting for review';
          else if (uiStatus==='input-required') statusText = 'Our Turn';
          else if (uiStatus==='working') statusText = 'Other side working';
          else if (uiStatus==='submitted' || uiStatus==='initializing') statusText = 'Setting up…';
          if (statusText) chips.push({ text: statusText, tone: statusText === 'Our Turn' ? 'blue' : 'gray', icon: React.createElement(ArrowLeftRight, { size:14, strokeWidth:1.75 }) });
        }
        return (
          <>
            <MetaBar elRef={metaRef} offset={48} left={<span />} chips={chips} right={<button className="btn secondary" onClick={clearTask} disabled={!taskId}>Clear task</button>} />
            {!taskId && (
              <div className="text-sm text-gray-500 mt-2">Send a message to begin a new task</div>
            )}
          </>
        );
      })()}

      {showDebug && <DebugPanel />}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-3" ref={gridRef}>
        <div className="flex flex-col gap-3 order-2 lg:order-none">
          {hasTranscript && (
            <div className="card">
              <div className={`transcript ${['completed','canceled','failed','rejected'].includes(uiStatus) ? 'faded' : ''}`} aria-live="polite" ref={transcriptRef}>
                {facts.map((f) => {
              if (f.type === 'message_received' || f.type === 'message_sent') {
                const isMe = f.type === 'message_sent';
                return (
                  <div key={f.id} className={'bubble ' + (isMe ? 'me' : 'them')}>
                    <div className="small muted">{isMe ? usLabel : otherLabel}</div>
                    <Markdown text={f.text} />
                    {Array.isArray(f.attachments) && f.attachments.length > 0 && (
                      <div className="attachments small">
                        {f.attachments.map((a:AttachmentMeta) => {
                          const added = facts.find(x => x.type === 'attachment_added' && (x as any).name === a.name);
                          const href = added && added.type === 'attachment_added' ? attachmentHrefFromBase64(a.name, added.mimeType, added.bytes) : null;
                          return (
                            <a key={a.name} className="att" href={href || '#'} target="_blank" rel="noreferrer" onClick={e => { if (!href) e.preventDefault(); }}>
                              📎 {a.name} <span className="muted">({a.mimeType || 'application/octet-stream'})</span>
                            </a>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              }
              if (f.type === 'agent_question' || f.type === 'user_answer' || f.type === 'compose_intent' || f.type === 'user_guidance' || (f as any).type === 'planner_error') {
                // Hide Q&A whispers like: "Answer <qid>: <text>"
                if (f.type === 'user_guidance') {
                  const t = String((f as any).text || '');
                  if (/^\s*Answer\s+[^:]+\s*:/.test(t)) return <div key={f.id} className="hidden" />;
                }
                // Hide approved/sent drafts; show dismissed drafts faded (intermediate state)
                if (f.type === 'compose_intent' && (approved.has(f.composeId) || sentComposeIds.has(f.composeId))) return <div key={f.id} className="hidden" />;
                const stripeClass =
                  f.type === 'user_guidance' ? 'stripe whisper' :
                  f.type === 'agent_question' ? 'stripe question' :
                  f.type === 'user_answer' ? 'stripe answer' :
                  (f as any).type === 'planner_error' ? 'stripe whisper' : 'stripe draft';
                const isDismissed = (f.type === 'compose_intent') && [...facts].some(x => x.type === 'compose_dismissed' && (x as any).composeId === f.composeId);
                // If a newer compose_intent exists, hide this dismissed one entirely
                if (f.type === 'compose_intent' && isDismissed) {
                  const hasNewerDraft = [...facts].some(x => x.type === 'compose_intent' && x.seq > f.seq);
                  if (hasNewerDraft) return <div key={f.id} className="hidden" />;
                }
                return (
                  <div key={f.id} className={'private ' + stripeClass + (isDismissed ? ' opacity-50' : '')}>
                    <div className="stripe-head">
                      {f.type === 'user_guidance' && 'Private • Whisper'}
                      {f.type === 'agent_question' && 'Private • Agent Question'}
                      {f.type === 'user_answer' && 'Private • Answer'}
                      {f.type === 'compose_intent' && (isDismissed ? 'Private • Draft (dismissed)' : 'Private • Draft')}
                      {(f as any).type === 'planner_error' && 'Private • Error'}
                    </div>
                    <div className="stripe-body">
                      {f.type === 'user_guidance' && <Markdown text={f.text} />}
                      {f.type === 'user_answer' && <Markdown text={(f as any).text} />}
                      {(f as any).type === 'planner_error' && (
                        <div className="text small">
                          <span className="pill bg-red-100 text-red-800 mr-2">{(f as any).code}</span>
                          <span>{(f as any).message}</span>
                        </div>
                      )}
                      {f.type === 'agent_question' && (()=>{
                        const answered = facts.some(x => x.type === 'user_answer' && (x as any).qid === (f as any).qid && x.seq > f.seq);
                        return <QuestionInline q={f as any} answered={answered} />;
                      })()}
                      {f.type === 'compose_intent' && (
                        isDismissed
                          ? <div className="text">{f.text}</div>
                           : <DraftInline composeId={f.composeId} text={f.text} attachments={f.attachments} nextStateHint={(f as any).nextStateHint as any} />
                       )}
                    </div>
                  </div>
                );
              }
              return <div key={f.id} />;
            })}
              </div>
              {plannerId !== 'off' && (
                <div className="transcript-bar">
                  <label className="small"><input type="checkbox" checked={autoScroll} onChange={(e)=>setAutoScroll(e.target.checked)} /> Auto scroll</label>
                </div>
              )}
            </div>
          )}
          {plannerId === 'off' && !['completed','canceled','failed','rejected'].includes(uiStatus) && (
            <ManualComposer
              disabled={!canSendManual}
              hint={!canSendManual ? (['completed','canceled','failed','rejected'].includes(uiStatus) ? `Task ${uiStatus}.` : (initiatorCanStart ? 'First send will start a conversation' : 'Not your turn')) : undefined}
              placeholder={composerPlaceholder()}
              onSend={handleManualSend}
              sending={sending}
            />
          )}
          <PlannerSetupCard />

          {['completed','canceled','failed','rejected'].includes(uiStatus) && (
            <button className="btn w-full py-4 mt-3" onClick={clearTask}>
              {`Task ${uiStatus}. Click here to begin again`}
            </button>
          )}
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
            <CollapsibleCard title="Automation" initialOpen>
              <AutomationCard bare hideTitle
                mode={useAppStore.getState().plannerMode as any}
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

      <div className="card hidden">
        <Whisper onSend={sendWhisper} />
      </div>
      

      <ClientSettingsModal
        open={showSettings}
        value={clientSettings}
        onCancel={()=>setShowSettings(false)}
        onSave={(next)=>{ saveClientSettings(next); setShowSettings(false); }}
        serverModels={serverModels}
      />
      </div>
    </SharedAppLayout>
  );
}

function HudBar() {
  const hud = useAppStore(s => s.hud);
  if (!hud) return null;
  const pct = typeof hud.p === 'number' ? Math.max(0, Math.min(1, hud.p)) : null;
  return (
    <div className="row mt-2" style={{ alignItems:'center' }}>
      <span className="small muted">HUD:</span>
      <span className="pill">{hud.phase}{hud.label ? ` — ${hud.label}` : ''}</span>
      {pct !== null && (
        <div className="flex-1" style={{ maxWidth: 200, height: 6, background: '#eef1f7', borderRadius: 4 }}>
          <div style={{ width: `${Math.round(pct*100)}%`, height: '100%', background:'#5b7cff', borderRadius: 4 }} />
        </div>
      )}
    </div>
  );
}

// DraftInline moved to ../components/DraftInline

// Whisper component moved to ../components/Whisper

function QuestionInline({ q, answered }:{ q:{ qid:string; prompt:string; placeholder?:string }, answered:boolean }) {
  const [txt, setTxt] = useState('');
  const [submitted, setSubmitted] = useState(false);
  function submit() {
    if (answered || submitted) return;
    useAppStore.getState().addUserAnswer(q.qid, txt);
    setSubmitted(true);
  }
  return (
    <div>
      <div className="mb-1.5"><Markdown text={q.prompt} /></div>
      <div className="row">
        <input className="input flex-1" placeholder={q.placeholder || 'Type your answer'} value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={(e)=>{ if (e.key==='Enter') submit(); }} disabled={answered || submitted} />
        <button className="btn" onClick={submit} disabled={answered || submitted}>{answered ? 'Answered' : (submitted ? 'Sending…' : 'Answer')}</button>
      </div>
      <div className="small muted mt-1">Private: your answer isn’t sent to the other side.</div>
    </div>
  );
}

// ManualComposer moved to ../components/ManualComposer

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

// TaskRibbon moved to ../components/TaskRibbon

// PlannerSelector and PlannerModeSelector moved to ../components/PlannerSelectors

// Removed inline PlannerSetupCard/renderField/DebugPanel; using extracted components.
