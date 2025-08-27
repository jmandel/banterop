import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AttachmentMeta } from '../../shared/journal-types';
import type { A2APart } from '../../shared/a2a-types';
import { useAppStore } from '../state/store';
import { A2AAdapter } from '../transports/a2a-adapter';
import { statusLabel } from './status-labels';
import { MCPAdapter } from '../transports/mcp-adapter';
import { startPlannerController } from '../planner/controller';
import { resolvePlanner } from '../planner/registry';
import { makeChitchatProvider, DEFAULT_CHITCHAT_ENDPOINT } from '../../shared/llm-provider';
import { b64ToUtf8, normalizeB64 } from '../../shared/codec';
import { decodeSetup } from '../../shared/setup-hash';
import { PlannerSetupCard } from './PlannerSetupCard';
import { DebugPanel } from './DebugPanel';

type Role = 'initiator'|'responder';

function useQuery() {
  const u = new URL(window.location.href);
  const role = (u.searchParams.get('role') === 'responder') ? 'responder' : 'initiator';
  const transport = (u.searchParams.get('transport') === 'mcp') ? 'mcp' : 'a2a';
  const a2aUrl = u.searchParams.get('a2a') || '';
  const tasksUrl = u.searchParams.get('tasks') || '';
  const mcpUrl = u.searchParams.get('mcp') || '';
  return { role, transport, a2aUrl, tasksUrl, mcpUrl };
}

function attachmentHrefFromBase64(name:string, mimeType:string, b64:string) {
  try {
    const bytes = atob(b64);
    const arr = new Uint8Array(bytes.length);
    for (let i=0;i<bytes.length;i++) arr[i] = bytes.charCodeAt(i);
    // Force explicit UTF-8 charset for all attachments (per request),
    // regardless of the original mimeType, to avoid mojibake in browsers.
    const baseType = mimeType || 'application/octet-stream';
    const type = /charset=/i.test(baseType) ? baseType : `${baseType};charset=utf-8`;
    const blob = new Blob([arr], { type });
    return URL.createObjectURL(blob);
  } catch { return null; }
}

function App() {
  const { role, transport, a2aUrl, tasksUrl, mcpUrl } = useQuery();
  const store = useAppStore();
  const [sending, setSending] = useState(false);

  type UrlSetup = {
    planner?: {
      id?: 'llm-drafter'|'scenario-v0.3'|'simple-demo'|'off';
      mode?: 'approve'|'auto';
      ready?: boolean;
      applied?: any;
      config?: any;
    };
    llm?: { model?: string };
    kickoff?: 'if-ready'|'always'|'never';
  };

function parseSetupFromLocation(): UrlSetup | null {
  try { return decodeSetup(window.location.hash) as any; } catch { return null; }
}

  // Hold parsed URL setup for planner bootstrap; do not seed store with partials
  const [urlSetup, setUrlSetup] = useState<UrlSetup | null>(null);
  function applySetupFromUrl(setup: UrlSetup) {
    if (!setup?.planner) return;
    const pid = (setup.planner.id || 'off') as any;
    useAppStore.getState().setPlanner(pid);
    if (setup.planner.mode) useAppStore.getState().setPlannerMode(setup.planner.mode);
    // Keep as local bootstrap only; config store will use it as opts.initial
    setUrlSetup(setup);
  }

  // init transport & role
  useEffect(() => {
    const adapter = transport === 'mcp' ? new MCPAdapter(mcpUrl) : new A2AAdapter(a2aUrl);
    store.init(role as Role, adapter, undefined);
    // Start planner controller for both roles; harness owns triggers/guards
    startPlannerController();
    // Apply URL setup (if provided)
    try { const setup = parseSetupFromLocation(); if (setup) applySetupFromUrl(setup); } catch {}
  }, [role, transport, a2aUrl, mcpUrl]);

  // Backchannel (responder, A2A): delegate to store attach/detach
  useEffect(() => {
    if (transport === 'a2a' && role === 'responder' && tasksUrl) {
      useAppStore.getState().attachBackchannel(tasksUrl);
      return () => { try { useAppStore.getState().detachBackchannel(); } catch {} };
    }
  }, [role, tasksUrl, transport]);

  const facts = useAppStore(s => s.facts);
  const taskId = useAppStore(s => s.taskId);
  const uiStatus = useAppStore(s => s.uiStatus());

  // Actions
  async function handleManualSend(text: string, finality: 'none'|'turn'|'conversation') {
    const composeId = useAppStore.getState().appendComposeIntent(text);
    setSending(true);
    try { await useAppStore.getState().sendCompose(composeId, finality); }
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
  const initiatorCanStart = role === 'initiator' && !taskId;
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
    <div className="wrap">
      <div className="card">
        <div className="row">
          {(() => {
            const transportLabel = transport === 'mcp' ? 'MCP' : 'A2A';
            const roleLabel = role === 'initiator' ? (transport === 'mcp' ? 'Client' : 'Client') : 'Server';
            const label = `${transportLabel} ${roleLabel}`;
            return (<div><strong>Role:</strong> <span className="pill">{label}</span></div>);
          })()}
          <PlannerSelector />
          <PlannerModeSelector />
          {role==='initiator' && (
            <button className="btn" onClick={clearTask} disabled={!taskId}>Clear task</button>
          )}
        </div>
      </div>

  <TaskRibbon />
  <PlannerSetupCard urlSetup={urlSetup} />

      <DebugPanel />
      <div className="card">
        <div className="transcript" aria-live="polite">
          {!facts.length && <div className="small muted">No events yet.</div>}
          {facts.map((f) => {
            if (f.type === 'remote_received' || f.type === 'remote_sent') {
              const isMe = f.type === 'remote_sent';
              return (
                <div key={f.id} className={'bubble ' + (isMe ? 'me' : 'them')}>
                  <div className="small muted">{isMe ? 'Our side' : 'Other side'}</div>
                  <div className="text">{f.text}</div>
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
                    {f.type === 'user_guidance' && <div className="text">{f.text}</div>}
                    {f.type === 'user_answer' && <div className="text">{(f as any).text}</div>}
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

        <ManualComposer
          disabled={!canSendManual}
          hint={!canSendManual ? (['completed','canceled','failed','rejected'].includes(uiStatus) ? `Task ${uiStatus}.` : (initiatorCanStart ? 'First send will start a conversation' : 'Not your turn')) : undefined}
          placeholder={composerPlaceholder()}
          onSend={handleManualSend}
          sending={sending}
        />
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

function DraftInline({ composeId, text, attachments }:{ composeId:string; text:string; attachments?: AttachmentMeta[] }) {
  const [finality, setFinality] = useState<'none'|'turn'|'conversation'>('turn');
  const [sending, setSending] = useState(false);
  const err = useAppStore(s => s.sendErrorByCompose.get(composeId));
  const pid = useAppStore(s => s.plannerId);
  const ready = useAppStore(s => !!s.readyByPlanner[s.plannerId]);
  const facts = useAppStore(s => s.facts);
  async function approve() {
    setSending(true);
    try { await useAppStore.getState().sendCompose(composeId, finality); }
    finally { setSending(false); }
  }
  async function retry() { await approve(); }
  function regenerate() {
    try { useAppStore.getState().dismissCompose(composeId); } catch {}
    // Nudge controller by changing appliedByPlanner identity (no-op clone)
    useAppStore.setState((s: any) => {
      const curr = s.appliedByPlanner[pid];
      return { appliedByPlanner: { ...s.appliedByPlanner, [pid]: curr ? { ...curr } : {} } };
    });
  }
  return (
    <div>
      <div className="text">{text}</div>
      {Array.isArray(attachments) && attachments.length > 0 && (
        <div className="attachments small" style={{ marginTop: 6 }}>
          {attachments.map((a:AttachmentMeta) => {
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
      <div className="row" style={{marginTop:8, gap:8}}>
        <select value={finality} onChange={(e)=>setFinality(e.target.value as any)}>
          <option value="none">no finality</option>
          <option value="turn">end turn → flip</option>
          <option value="conversation">end conversation</option>
        </select>
        <button className="btn" onClick={()=>void approve()} disabled={sending}>{sending ? 'Sending…' : 'Approve & Send'}</button>
        {ready && (
          <button className="btn ghost" onClick={regenerate} title="Dismiss current draft and ask the planner to generate a new suggestion">Regenerate suggestion</button>
        )}
      </div>
      {err && (
        <div className="small" style={{ color:'#b91c1c', marginTop:6 }}>
          {err} <button className="btn ghost" onClick={()=>void retry()}>Retry</button>
        </div>
      )}
    </div>
  );
}

function Whisper({ onSend }:{ onSend:(t:string)=>void }) {
  const [open, setOpen] = useState(false);
  const [txt, setTxt] = useState('');
  return (
    <div style={{width:'100%'}}>
      <div className="row" style={{justifyContent:'space-between'}}>
        <div className="small muted">Whisper to our agent (private)</div>
        <button className="btn ghost" onClick={() => setOpen(v=>!v)}>{open ? 'Hide' : 'Open'}</button>
      </div>
      {open && (
        <div className="row" style={{marginTop:6}}>
          <input className="input" style={{flex:1}} placeholder="e.g., Emphasize failed PT and work impact" value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={(e)=>{ if (e.key==='Enter') { onSend(txt); setTxt(''); } }} />
          <button className="btn" onClick={()=>{ onSend(txt); setTxt(''); }}>Send whisper</button>
        </div>
      )}
    </div>
  );
}

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
      <div className="text" style={{marginBottom:6}}>{q.prompt}</div>
      <div className="row">
        <input className="input" style={{flex:1}} placeholder={q.placeholder || 'Type your answer'} value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={(e)=>{ if (e.key==='Enter') submit(); }} disabled={answered || submitted} />
        <button className="btn" onClick={submit} disabled={answered || submitted}>{answered ? 'Answered' : (submitted ? 'Sending…' : 'Answer')}</button>
      </div>
      <div className="small muted" style={{marginTop:4}}>Private: your answer isn’t sent to the other side.</div>
    </div>
  );
}

function ManualComposer({ disabled, hint, placeholder, onSend, sending }:{ disabled:boolean; hint?:string; placeholder?:string; onSend:(t:string, f:'none'|'turn'|'conversation')=>Promise<void>|void; sending:boolean }) {
  const [text, setText] = useState('');
  const [finality, setFinality] = useState<'none'|'turn'|'conversation'>('turn');
  async function send() {
    const t = text.trim(); if (!t || disabled) return;
    setText('');
    await onSend(t, finality);
  }
  return (
    <div className="manual-composer">
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <input
          className="input"
          style={{ flex: 1 }}
          value={text}
          placeholder={placeholder || (disabled ? 'Not your turn yet…' : 'Type a message to the other side…')}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (!disabled) void send(); } }}
          disabled={disabled || sending}
        />
        <select
          value={finality}
          onChange={(e) => setFinality(e.target.value as any)}
          disabled={sending}
          title="Finality hint"
        >
          <option value="none">no finality</option>
          <option value="turn">end turn → flip</option>
          <option value="conversation">end conversation</option>
        </select>
        <button className="btn" onClick={() => void send()} disabled={disabled || sending} aria-disabled={disabled || sending} title={disabled ? (hint || 'Not your turn to send') : 'Send message'}>
          Send
        </button>
      </div>
      {hint && <div className="small muted" style={{ marginTop: 6 }}>{hint}</div>}
      <style>{`
        .manual-composer {
          position: sticky;
          bottom: 0;
          background: #fff;
          border-top: 1px solid #e6e8ee;
          padding: 10px;
          border-radius: 0 0 10px 10px;
        }
        /* Style inputs/selects uniformly; do not override .btn styles */
        .manual-composer input, .manual-composer select {
          font: inherit;
          padding: 8px 10px;
          border-radius: 8px;
          border: 1px solid #d4d8e2;
          background: #fff;
        }
      `}</style>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);

function TaskRibbon() {
  const taskId = useAppStore(s => s.taskId);
  const uiStatus = useAppStore(s => s.uiStatus());
  function statusBadgeText(s: string): string { return statusLabel(s); }
  return (
    <div className="card">
      <div className="row" style={{ alignItems:'center', gap: 10 }}>
        <strong>Task</strong>
        <span className="pill">ID: {taskId || '—'}</span>
        <span className="pill">Status: {statusBadgeText(uiStatus)}</span>
      </div>
    </div>
  );
}

function PlannerSelector() {
  const pid = useAppStore(s => s.plannerId);
  const setPlanner = useAppStore(s => s.setPlanner);
  return (
    <div className="row" style={{ gap: 6, alignItems:'center' }}>
      <span className="small muted">Planner:</span>
      <select value={pid} onChange={e => setPlanner(e.target.value as any)}>
        <option value="off">Off</option>
        <option value="llm-drafter">LLM Drafter</option>
        <option value="scenario-v0.3">Scenario Planner</option>
      </select>
    </div>
  );
}

function PlannerModeSelector() {
  const mode = useAppStore(s => s.plannerMode);
  const setMode = useAppStore(s => s.setPlannerMode);
  return (
    <div className="row" style={{ gap: 6, alignItems:'center' }}>
      <span className="small muted">Mode:</span>
      <select value={mode} onChange={e => setMode(e.target.value as any)} title="Planner approval mode">
        <option value="approve">Approve each turn</option>
        <option value="auto">Auto-approve</option>
      </select>
    </div>
  );
}

// Removed inline PlannerSetupCard/renderField/DebugPanel; using extracted components.
