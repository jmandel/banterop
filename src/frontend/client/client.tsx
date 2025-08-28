import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AttachmentMeta } from '../../shared/journal-types';
import { useAppStore } from '../state/store';
import { A2AAdapter } from '../transports/a2a-adapter';
import { statusLabel } from '../components/status-labels';
import { MCPAdapter } from '../transports/mcp-adapter';
import { startPlannerController } from '../planner/controller';
import { resolvePlanner } from '../planner/registry';
import { makeChitchatProvider, DEFAULT_CHITCHAT_ENDPOINT } from '../../shared/llm-provider';
import { b64ToUtf8, normalizeB64 } from '../../shared/codec';
import { useUrlPlannerSetup } from '../hooks/useUrlPlannerSetup';
import { PlannerSetupCard } from './PlannerSetupCard';
import { DebugPanel } from './DebugPanel';
import { TaskRibbon } from '../components/TaskRibbon';
import { PlannerSelector, PlannerModeSelector } from '../components/PlannerSelectors';
import { ManualComposer } from '../components/ManualComposer';
import { Whisper } from '../components/Whisper';
import { DraftInline } from '../components/DraftInline';
import { Markdown } from '../components/Markdown';
import { attachmentHrefFromBase64 } from '../components/attachments';

function useQuery() {
  const u = new URL(window.location.href);
  const cardUrl = u.searchParams.get('card') || '';
  const mcpUrl = u.searchParams.get('mcp') || '';
  return { cardUrl, mcpUrl };
}

// attachmentHrefFromBase64 moved to ../components/attachments

function App() {
  const { cardUrl, mcpUrl } = useQuery();
  const store = useAppStore();
  const [sending, setSending] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [resolvedA2A, setResolvedA2A] = useState<string>('');
  const [resolvedMcp, setResolvedMcp] = useState<string>('');
  const [cardError, setCardError] = useState<string | null>(null);

  // Parse and apply #setup to store; provide to PlannerSetupCard
  const urlSetup = useUrlPlannerSetup() as any;

  // Resolve endpoints from Agent Card (if provided), else use fallback params
  useEffect(() => {
    let cancelled = false;
    async function resolveCard() {
      setCardError(null);
      setResolvedA2A('');
      setResolvedMcp(mcpUrl || '');
      if (!cardUrl) return;
      try {
        const res = await fetch(cardUrl, { method: 'GET' });
        if (!res.ok) throw new Error(`fetch card failed: ${res.status}`);
        const card = await res.json();
        if (cancelled) return;
        const url = String(card?.url || '');
        setResolvedA2A(url);
      } catch (e:any) {
        setCardError(String(e?.message || 'Failed to load Agent Card'));
      }
    }
    resolveCard();
    return () => { cancelled = true };
  }, [cardUrl, mcpUrl]);

  // Determine transport: prefer Agent Card (A2A) if provided, else MCP if mcpUrl present, else fallback to A2A
  const transport: 'a2a'|'mcp' = cardUrl ? 'a2a' : (mcpUrl || resolvedMcp ? 'mcp' : 'a2a');

  // init adapter once endpoints resolved
  useEffect(() => {
    const endpointA2A = resolvedA2A;
    const endpointMcp = resolvedMcp || mcpUrl;
    if (transport === 'a2a' && !endpointA2A) return;
    if (transport === 'mcp' && !endpointMcp) return;
    const adapter = transport === 'mcp' ? new MCPAdapter(endpointMcp) : new A2AAdapter(endpointA2A);
    store.init('initiator' as any, adapter, undefined);
    startPlannerController();
  }, [transport, resolvedA2A, resolvedMcp, a2aUrl, mcpUrl]);

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
  async function handleManualSend(text: string, nextState: 'working'|'input-required'|'completed'|'canceled'|'failed'|'rejected'|'auth-required') {
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
    return 'Not your turn yet…';
  }

  return (
    <div className={`wrap ${showDebug ? 'with-debug' : ''}`}>
      <div className="card compact sticky" style={{ top: 0 }}>
        <div className="row compact">
          {(() => {
            const transportLabel = transport === 'mcp' ? 'MCP' : 'A2A';
            const label = `${transportLabel} Client`;
            return (<div><strong>Role:</strong> <span className="pill">{label}</span></div>);
          })()}
          <PlannerSelector />
          <PlannerModeSelector />
          <button className="btn" onClick={clearTask} disabled={!taskId}>Clear task</button>
          {cardError && <span className="small" style={{ color:'#b91c1c' }}>{cardError}</span>}
          <label className="small" style={{marginLeft:'auto'}}>
            <input type="checkbox" checked={showDebug} onChange={(e)=>setShowDebug(e.target.checked)} /> Show debug
          </label>
        </div>
      </div>

  <div className="sticky" style={{ top: 48 }}>
    <TaskRibbon />
  </div>
  <PlannerSetupCard urlSetup={urlSetup} />

      {showDebug && <DebugPanel />}
      <div className="card">
        <div className="transcript" aria-live="polite" ref={transcriptRef}>
          {!facts.length && <div className="small muted">No events yet.</div>}
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
                if (/^\s*Answer\s+[^:]+\s*:/.test(t)) return <div key={f.id} style={{display:'none'}} />;
              }
              // Hide approved/sent drafts; show dismissed drafts faded (intermediate state)
              if (f.type === 'compose_intent' && (approved.has(f.composeId) || sentComposeIds.has(f.composeId))) return <div key={f.id} style={{display:'none'}} />;
              const stripeClass =
                f.type === 'user_guidance' ? 'stripe whisper' :
                f.type === 'agent_question' ? 'stripe question' :
                f.type === 'user_answer' ? 'stripe answer' : 'stripe draft';
              const isDismissed = (f.type === 'compose_intent') && [...facts].some(x => x.type === 'compose_dismissed' && (x as any).composeId === f.composeId);
              // If a newer compose_intent exists, hide this dismissed one entirely
              if (f.type === 'compose_intent' && isDismissed) {
                const hasNewerDraft = [...facts].some(x => x.type === 'compose_intent' && x.seq > f.seq);
                if (hasNewerDraft) return <div key={f.id} style={{display:'none'}} />;
              }
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
                    {f.type === 'agent_question' && (()=>{
                      const answered = facts.some(x => x.type === 'user_answer' && (x as any).qid === (f as any).qid && x.seq > f.seq);
                      return <QuestionInline q={f as any} answered={answered} />;
                    })()}
                    {f.type === 'compose_intent' && (
                      isDismissed
                        ? <div className="text">{f.text}</div>
                        : <DraftInline composeId={f.composeId} text={f.text} attachments={f.attachments} />
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

        {plannerId === 'off' && (
          <ManualComposer
            disabled={!canSendManual}
            hint={!canSendManual ? (['completed','canceled','failed','rejected'].includes(uiStatus) ? `Task ${uiStatus}.` : (initiatorCanStart ? 'First send will start a conversation' : 'Not your turn')) : undefined}
            placeholder={composerPlaceholder()}
            onSend={handleManualSend}
            sending={sending}
          />
        )}
      </div>

      <div className="card">
        <Whisper onSend={sendWhisper} />
      </div>
    </div>
  );
}

function HudBar() {
  const hud = useAppStore(s => s.hud);
  if (!hud) return null;
  const pct = typeof hud.p === 'number' ? Math.max(0, Math.min(1, hud.p)) : null;
  return (
    <div className="row" style={{ marginTop: 8, gap: 8, alignItems:'center' }}>
      <span className="small muted">HUD:</span>
      <span className="pill">{hud.phase}{hud.label ? ` — ${hud.label}` : ''}</span>
      {pct !== null && (
        <div style={{ flex: 1, maxWidth: 200, height: 6, background: '#eef1f7', borderRadius: 4 }}>
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
      <div style={{marginBottom:6}}><Markdown text={q.prompt} /></div>
      <div className="row">
        <input className="input" style={{flex:1}} placeholder={q.placeholder || 'Type your answer'} value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={(e)=>{ if (e.key==='Enter') submit(); }} disabled={answered || submitted} />
        <button className="btn" onClick={submit} disabled={answered || submitted}>{answered ? 'Answered' : (submitted ? 'Sending…' : 'Answer')}</button>
      </div>
      <div className="small muted" style={{marginTop:4}}>Private: your answer isn’t sent to the other side.</div>
    </div>
  );
}

// ManualComposer moved to ../components/ManualComposer

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

// TaskRibbon moved to ../components/TaskRibbon

// PlannerSelector and PlannerModeSelector moved to ../components/PlannerSelectors

// Removed inline PlannerSetupCard/renderField/DebugPanel; using extracted components.
