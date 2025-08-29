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
import { makeChitchatProvider, DEFAULT_CHITCHAT_ENDPOINT, DEFAULT_CHITCHAT_MODEL } from '../../shared/llm-provider';
import { b64ToUtf8, normalizeB64 } from '../../shared/codec';
import { startUrlSync } from '../hooks/startUrlSync';
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
import { ClientLinksCard } from './components/ClientLinksCard';
import { TopBar } from '../components/TopBar';
import { MetaBar } from '../components/MetaBar';

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
    try {
      // Preserve any existing API key in session when reading from hash
      let existingApiKey: string | undefined = undefined;
      try {
        const prevRaw = window.sessionStorage.getItem('clientSettings');
        if (prevRaw) {
          const prev = JSON.parse(prevRaw);
          existingApiKey = prev?.llm?.apiKey || '';
        }
      } catch {}
      const rawHash = window.location.hash?.slice(1) || '';
      const cand = [rawHash];
      try { cand.push(decodeURIComponent(rawHash)); } catch {}
      for (const s of cand) {
        const t = (s || '').trim();
        if (t.startsWith('{') && t.endsWith('}')) {
          const j = JSON.parse(t);
          if (j && typeof j === 'object') {
            const llm = j.llm || {};
            const provider = (llm.provider === 'client-openai') ? 'client-openai' : 'server';
            const model = typeof llm.model === 'string' && llm.model.trim() ? llm.model.trim() : DEFAULT_CHITCHAT_MODEL;
            const baseUrl = provider === 'client-openai' ? (llm.baseUrl || 'https://openrouter.ai/api/v1') : undefined;
            // Do NOT read apiKey from the hash; keep any existing value
            const apiKey = provider === 'client-openai' ? (existingApiKey || '') : undefined;
            const a2aCardUrl = String(j.agentCardUrl || '');
            const mcpUrl = String(j.mcpUrl || '');
            // Infer transport from presence of URLs (prefer A2A when both present)
            const transport = a2aCardUrl ? 'a2a' : (mcpUrl ? 'mcp' : 'a2a');
            const boot = { transport, a2aCardUrl, mcpUrl, llm: { provider, model, baseUrl, apiKey } } as ClientSettings;
            // Persist immediately so controller picks it up
            try { window.sessionStorage.setItem('clientSettings', JSON.stringify(boot)); } catch {}
            return boot;
          }
        }
      }
    } catch {}
    try {
      const raw = window.sessionStorage.getItem('clientSettings');
      if (raw) return JSON.parse(raw);
    } catch {}
    if (cardUrl) return { transport: 'a2a', a2aCardUrl: cardUrl, mcpUrl: '', llm: { provider: 'server', model: DEFAULT_CHITCHAT_MODEL } };
    if (mcpUrl)  return { transport: 'mcp', a2aCardUrl: '', mcpUrl, llm: { provider: 'server', model: DEFAULT_CHITCHAT_MODEL } };
    return { transport: 'a2a', a2aCardUrl: '', mcpUrl: '', llm: { provider: 'server', model: DEFAULT_CHITCHAT_MODEL } };
  }
  const [clientSettings, setClientSettings] = useState<ClientSettings>(loadClientSettings);
  function saveClientSettings(next: ClientSettings) {
    setClientSettings(next);
    try { window.sessionStorage.setItem('clientSettings', JSON.stringify(next)); } catch {}
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
        setResolvedMcp(clientSettings.mcpUrl || '');
        return;
      }
      const url = (clientSettings.a2aCardUrl || '').trim();
      if (!url) return;
      try {
        const res = await fetch(url, { method: 'GET' });
        if (!res.ok) throw new Error(`fetch card failed: ${res.status}`);
        const card = await res.json();
        if (cancelled) return;
        const resolved = String(card?.url || '');
        setResolvedA2A(resolved);
      } catch (e:any) {
        setCardError(String(e?.message || 'Failed to load Agent Card'));
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
    const adapter = transport === 'mcp' ? new MCPAdapter(endpointMcp) : new A2AAdapter(endpointA2A);
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
    for (const f of facts) if (f.type === 'remote_sent' && (f as any).composeId) s.add((f as any).composeId as string);
    return s;
  }, [facts]);
  const hasTranscript = React.useMemo(() => {
    for (const f of facts) {
      if (f.type === 'remote_received' || f.type === 'remote_sent') return true;
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

  return (
    <div className={`wrap ${showDebug ? 'with-debug' : ''}`}>
      <TopBar
        left={(
          <div className="row compact">
            <span className="small muted">Client</span>
            <span className="pill">{transport === 'mcp' ? 'MCP' : 'A2A'}</span>
          </div>
        )}
        right={(
          <button title="Settings" aria-label="Settings" onClick={()=>setShowSettings(true)} className="p-1 ml-2 text-gray-600 hover:text-gray-900 bg-transparent border-0">⚙️</button>
        )}
      />

      <MetaBar
        left={<span className="small muted">Task</span>}
        chips={(() => {
          const chips:any[] = [{ text: taskId ? `Task ${taskId}` : 'No task', tone: 'gray' as const }];
          const dismissed = new Set<string>(facts.filter((f:any)=>f.type==='compose_dismissed').map((f:any)=>String(f.composeId||'')));
          let pendingReview = false;
          for (let i = facts.length - 1; i >= 0; --i) { const f:any = facts[i]; if (f.type==='remote_sent') break; if (f.type==='compose_intent' && !dismissed.has(String(f.composeId||''))) { pendingReview = true; break; } }
          if (!taskId) {
            chips.push({ text: 'Send a message to begin a new task', tone: 'gray' });
          } else if (['completed','canceled','failed','rejected'].includes(uiStatus)) chips.push({ text: uiStatus, tone:'blue' });
          else if (pendingReview && useAppStore.getState().plannerMode==='approve') chips.push({ text:'Waiting for review', tone:'amber' });
          else if (uiStatus==='input-required') chips.push({ text:'Our turn', tone:'amber' });
          else if (uiStatus==='working') chips.push({ text:'Other side working', tone:'blue' });
          else if (uiStatus==='submitted' || uiStatus==='initializing') chips.push({ text:'Setting up…', tone:'blue' });
          else chips.push({ text: uiStatus || 'Unknown', tone:'gray' });
          return chips;
        })()}
        right={<button className="btn secondary" onClick={clearTask} disabled={!taskId}>Clear task</button>}
      />

      {showDebug && <DebugPanel />}

      <div className="grid grid-cols-[1fr_340px] gap-3">
        <div>
          {hasTranscript && (
            <div className="card">
              <div className={`transcript ${['completed','canceled','failed','rejected'].includes(uiStatus) ? 'faded' : ''}`} aria-live="polite" ref={transcriptRef}>
                {facts.map((f) => {
              if (f.type === 'remote_received' || f.type === 'remote_sent') {
                const isMe = f.type === 'remote_sent';
                return (
                  <div key={f.id} className={'bubble ' + (isMe ? 'me' : 'them')}>
                    <div className="small muted">{isMe ? 'Our side' : 'Other side'}</div>
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
              if (f.type === 'agent_question' || f.type === 'user_answer' || f.type === 'compose_intent' || f.type === 'user_guidance') {
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
                  f.type === 'user_answer' ? 'stripe answer' : 'stripe draft';
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
                    </div>
                    <div className="stripe-body">
                      {f.type === 'user_guidance' && <Markdown text={f.text} />}
                      {f.type === 'user_answer' && <Markdown text={(f as any).text} />}
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
        </div>

        <div className="flex flex-col gap-3">
          <AutomationCard
            mode={useAppStore.getState().plannerMode as any}
            onModeChange={(m)=>useAppStore.getState().setPlannerMode(m)}
            plannerSelect={<PlannerSelector />}
          />
          <ClientLinksCard />
          <LogCard rows={facts.slice(-100).map((f:any)=>({ id:f.id, ts:f.ts, type:f.type }))} />
        </div>
      </div>

      {plannerId === 'off' && !['completed','canceled','failed','rejected'].includes(uiStatus) && (
        <ManualComposer
          disabled={!canSendManual}
          hint={!canSendManual ? (['completed','canceled','failed','rejected'].includes(uiStatus) ? `Task ${uiStatus}.` : (initiatorCanStart ? 'First send will start a conversation' : 'Not your turn')) : undefined}
          placeholder={composerPlaceholder()}
          onSend={handleManualSend}
          sending={sending}
        />
      )}

      <div className="card hidden">
        <Whisper onSend={sendWhisper} />
      </div>
      {['completed','canceled','failed','rejected'].includes(uiStatus) && (
        <button className="btn w-full py-4 mt-3" onClick={clearTask}>
          {`Task ${uiStatus}. Click here to begin again`}
        </button>
      )}
      <PlannerSetupCard />

      <ClientSettingsModal
        open={showSettings}
        value={clientSettings}
        onCancel={()=>setShowSettings(false)}
        onSave={(next)=>{ saveClientSettings(next); setShowSettings(false); }}
        serverModels={serverModels}
      />
    </div>
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
