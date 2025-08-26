import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AttachmentMeta } from '../../shared/journal-types';
import type { A2APart } from '../../shared/a2a-types';
import { useAppStore } from '../state/store';
import { A2AAdapter } from '../transports/a2a-adapter';
import { MCPAdapter } from '../transports/mcp-adapter';
import { startPlannerController } from '../planner/controller';
import { PlannerRegistry } from '../planner/registry';

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
    const blob = new Blob([arr], { type: mimeType || 'application/octet-stream' });
    return URL.createObjectURL(blob);
  } catch { return null; }
}

function App() {
  const { role, transport, a2aUrl, tasksUrl, mcpUrl } = useQuery();
  const store = useAppStore();
  const [sending, setSending] = useState(false);

  // init transport & role
  useEffect(() => {
    const adapter = transport === 'mcp' ? new MCPAdapter(mcpUrl) : new A2AAdapter(a2aUrl);
    store.init(role as Role, adapter, undefined);
    // Start planner controller for both roles; harness owns triggers/guards
    startPlannerController();
  }, [role, transport, a2aUrl, mcpUrl]);

  // Backchannel for responder (A2A) – listen for subscribe to learn taskId
  useEffect(() => {
    if (transport !== 'a2a') return;
    if (role === 'responder' && tasksUrl) {
      const es = new EventSource(tasksUrl);
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          const msg = payload.result;
          if (msg?.type === 'subscribe' && msg.taskId) {
            // Store owns driver start + initial fetch on setTaskId
            useAppStore.getState().setTaskId(msg.taskId);
          }
        } catch {}
      };
      return () => { try { es.close(); } catch {} };
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
    if (uiStatus === 'working') return 'Other side is working…';
    if (uiStatus === 'auth-required') return 'Authentication required…';
    if (uiStatus === 'unknown') return 'Waiting…';
    // Default not-your-turn message
    return 'Not your turn yet…';
  }

  return (
    <div className="wrap">
      <div className="card">
        <div className="row">
          <div><strong>Role:</strong> <span className="pill">{role === 'initiator' ? 'Initiator' : 'Responder'}</span></div>
          <PlannerSelector />
          <PlannerModeSelector />
          {role==='initiator' && (
            <button className="btn" onClick={clearTask} disabled={!taskId}>Clear task</button>
          )}
        </div>
      </div>

      <TaskRibbon />
      <PlannerSetupCard />

      <DebugPanel />
      <div className="card">
        <div className="transcript">
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
                        const added = [...facts].reverse().find(x => x.type === 'attachment_added' && x.name === a.name);
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
            if (f.type === 'agent_question' || f.type === 'agent_answer' || f.type === 'compose_intent' || f.type === 'user_guidance') {
              // Hide approved/sent/dismissed drafts
              if (f.type === 'compose_intent' && (approved.has(f.composeId) || sentComposeIds.has(f.composeId))) return <div key={f.id} style={{display:'none'}} />;
              if (f.type === 'compose_intent') {
                const dismissed = [...facts].some(x => x.type === 'compose_dismissed' && (x as any).composeId === f.composeId);
                if (dismissed) return <div key={f.id} style={{display:'none'}} />;
              }
              const stripeClass =
                f.type === 'user_guidance' ? 'stripe whisper' :
                f.type === 'agent_question' ? 'stripe question' :
                f.type === 'agent_answer' ? 'stripe answer' : 'stripe draft';
              return (
                <div key={f.id} className={'private ' + stripeClass}>
                  <div className="stripe-head">
                    {f.type === 'user_guidance' && 'Private • Whisper'}
                    {f.type === 'agent_question' && 'Private • Agent Question'}
                    {f.type === 'agent_answer' && 'Private • Answer'}
                    {f.type === 'compose_intent' && 'Private • Draft'}
                  </div>
                  <div className="stripe-body">
                    {f.type === 'user_guidance' && <div className="text">{f.text}</div>}
                    {f.type === 'agent_answer' && <div className="text">{f.text}</div>}
                    {f.type === 'agent_question' && (
                      <QuestionInline q={f} />
                    )}
                    {f.type === 'compose_intent' && (
                      <DraftInline composeId={f.composeId} text={f.text} />
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

function DraftInline({ composeId, text }:{ composeId:string; text:string }) {
  const [finality, setFinality] = useState<'none'|'turn'|'conversation'>('turn');
  const [sending, setSending] = useState(false);
  const err = useAppStore(s => s.sendErrorByCompose.get(composeId));
  async function approve() {
    setSending(true);
    try { await useAppStore.getState().sendCompose(composeId, finality); }
    finally { setSending(false); }
  }
  async function retry() { await approve(); }
  return (
    <div>
      <div className="text">{text}</div>
      <div className="row" style={{marginTop:8, gap:8}}>
        <select value={finality} onChange={(e)=>setFinality(e.target.value as any)}>
          <option value="none">no finality</option>
          <option value="turn">end turn → flip</option>
          <option value="conversation">end conversation</option>
        </select>
        <button className="btn" onClick={()=>void approve()} disabled={sending}>{sending ? 'Sending…' : 'Approve & Send'}</button>
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

function QuestionInline({ q }:{ q:{ qid:string; prompt:string; placeholder?:string } }) {
  const [txt, setTxt] = useState('');
  function submit() { useAppStore.getState().addUserGuidance(`Answer ${q.qid}: ${txt}`); }
  return (
    <div>
      <div className="text" style={{marginBottom:6}}>{q.prompt}</div>
      <div className="row">
        <input className="input" style={{flex:1}} placeholder={q.placeholder || 'Type your answer'} value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={(e)=>{ if (e.key==='Enter') submit(); }} />
        <button className="btn" onClick={submit}>Answer</button>
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
  return (
    <div className="card">
      <div className="row" style={{ alignItems:'center', gap: 10 }}>
        <strong>Task</strong>
        <span className="pill">ID: {taskId || '—'}</span>
        <span className="pill">Status: {uiStatus}</span>
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

function PlannerSetupCard() {
  const pid = useAppStore(s => s.plannerId);
  const staged = useAppStore(s => s.stagedByPlanner[pid]);
  const applied = useAppStore(s => s.appliedByPlanner[pid]);
  const ready = useAppStore(s => !!s.readyByPlanner[pid]);
  const taskId = useAppStore(s => s.taskId);
  const role = useAppStore(s => s.role);
  const hud = useAppStore(s => s.hud);
  const facts = useAppStore(s => s.facts);
  const set = useAppStore.getState();
  const [errors, setErrors] = React.useState<{ targetWords?: string }>({});
  const [collapsed, setCollapsed] = React.useState<boolean>(ready);

  React.useEffect(() => {
    // Auto-collapse once planner becomes ready
    if (ready) setCollapsed(true);
  }, [ready]);

  // Detect unsent draft (ignoring dismissed); walk back until a remote_sent
  const hasUnsentDraft = React.useMemo(() => {
    const dismissed = new Set<string>();
    for (const f of facts) if (f.type === 'compose_dismissed') dismissed.add((f as any).composeId);
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'remote_sent') break;
      if (f.type === 'compose_intent') {
        if (!dismissed.has((f as any).composeId)) return true;
      }
    }
    return false;
  }, [facts]);

  if (pid !== 'llm-drafter') return null;

  function validate() {
    const e: { targetWords?: string } = {};
    const tw = Number(staged?.targetWords || 0);
    if (!Number.isFinite(tw) || tw < 0) e.targetWords = 'Enter 0 to disable, or a positive number.';
    if (Number.isFinite(tw) && tw !== 0 && (tw < 10 || tw > 1000)) e.targetWords = 'Enter a number between 10 and 1000, or 0 to disable.';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  function save() {
    if (!validate()) return;
    set.saveAndApplyPlannerCfg(pid);
    // Consistent UX: collapse after successful save
    try { setCollapsed(true); } catch {}
  }

  const canBegin = ready && role === 'initiator' && !taskId && !hasUnsentDraft;
  const sysA = String(staged?.systemAppend || '');
  const twS = Number(staged?.targetWords || 0);
  const sysB = String(applied?.systemAppend || '');
  const twB = Number(applied?.targetWords || 0);
  const dirty = !!staged && (applied == null || sysA !== sysB || twS !== twB);
  const hasErrors = !!errors.targetWords;

  return (
    <div className="card" style={{ marginTop: 10 }}>
      <div style={{ display:'flex', alignItems:'center', gap: 10 }}>
        <button className="btn ghost" onClick={()=> setCollapsed(v=>!v)} aria-label={collapsed ? 'Expand planner setup' : 'Collapse planner setup'}>
          {collapsed ? '▸' : '▾'}
        </button>
        <strong>Planner — LLM Drafter</strong>
        <span className="small muted" style={{ marginLeft: 8 }}>
          {ready ? 'Ready' : 'Not configured'}
          {collapsed ? (()=>{
            const cfgForSummary = staged ?? applied ?? {};
            const reg = (PlannerRegistry as any)[pid];
            const s = reg?.summary ? reg.summary(cfgForSummary) : '';
            return s ? ` • ${s}` : '';
          })() : ''}
        </span>
        <span style={{ marginLeft: 'auto' }} />
        {hud && hud.phase !== 'idle' && (
          <div className="row" style={{ gap:8, alignItems:'center' }}>
            <span className="pill">{hud.phase}{hud.label ? ` — ${hud.label}` : ''}</span>
            {typeof hud.p === 'number' && (
              <div style={{ width: 160, height: 6, background: '#eef1f7', borderRadius: 4 }}>
                <div style={{ width: `${Math.round(Math.max(0, Math.min(1, hud.p))*100)}%`, height: '100%', background:'#5b7cff', borderRadius: 4 }} />
              </div>
            )}
          </div>
        )}
        {!collapsed && (
          <button className="btn" onClick={save} disabled={!staged || !dirty || hasErrors}>Save & Apply</button>
        )}
        {canBegin && <button className="btn" onClick={()=> set.kickoffConversationWithPlanner()}>Begin conversation</button>}
      </div>
      {!collapsed && (
        <div
          style={{
            marginTop: 10,
            display: 'flex',
            flexWrap: 'wrap',
            gap: 12,
            alignItems: 'flex-start',
          }}
        >
          <div style={{ flex: '2 1 420px', minWidth: 280, maxWidth: 640 }}>
            <label className="small" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
              System prompt (append)
            </label>
            <textarea
              className="input"
              placeholder="Optional: appended to the built‑in system prompt"
              value={String(staged?.systemAppend || '')}
              onChange={(e) => set.stagePlannerCfg(pid, { systemAppend: e.target.value })}
              style={{ width: '100%', minHeight: 80, resize: 'vertical', boxSizing: 'border-box' }}
            />
            <div className="small muted" style={{ marginTop: 4 }}>
              Optional text appended to the system prompt.
            </div>
          </div>
          <div style={{ flex: '1 1 220px', minWidth: 200, maxWidth: 320 }}>
            <label className="small" style={{ display: 'block', fontWeight: 600, marginBottom: 6 }}>
              Target length (words)
            </label>
            <input
              className="input"
              type="number"
              min={0}
              step={10}
              value={Number(staged?.targetWords || 0)}
              onChange={(e) => {
                set.stagePlannerCfg(pid, { targetWords: Number(e.target.value || 0) });
              }}
              onBlur={validate}
              style={{ width: '100%', boxSizing: 'border-box' }}
              placeholder="0 (no target)"
            />
            {errors.targetWords ? (
              <div className="small" style={{ color: '#c62828', marginTop: 4 }}>{errors.targetWords}</div>
            ) : (
              <div className="small muted" style={{ marginTop: 4 }}>Aim near this length; set 0 to disable.</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function DebugPanel() {
  const facts = useAppStore(s => s.facts);
  const seq = useAppStore(s => s.seq);
  const taskId = useAppStore(s => s.taskId);
  const [copied, setCopied] = useState(false);
  const payload = JSON.stringify({ taskId, seq, facts }, null, 2);
  async function copy() {
    try { await navigator.clipboard.writeText(payload); setCopied(true); setTimeout(()=>setCopied(false), 1200); } catch {}
  }
  return (
    <aside className="debug-panel" aria-label="Debug facts panel">
      <div className="debug-header">
        <strong style={{ color:'#e3f0ff' }}>Journal</strong>
        <span style={{ marginLeft:'auto', fontSize:12, color:'#93c5fd' }}>seq {seq}</span>
        <button className="debug-btn" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <div className="debug-body">
        <pre className="debug-pre">{payload}</pre>
      </div>
    </aside>
  );
}
