import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { A2APart, A2ATask, A2AStatus } from '../shared/a2a-types';
import type { Fact, AttachmentMeta, ProposedFact } from '../shared/journal-types';
import { Journal, PlannerHarness } from './planner/harness';
import { SimpleDemoPlanner } from './planner/planners/simple-demo';
import { A2AClient } from './transport/a2a-client';
import type { FrameResult } from './transport/a2a-client';
import type { ServerEvent } from '../shared/backchannel-types';
import { ManualComposer, type Finality } from './components/ManualComposer';

type Role = 'initiator'|'responder';

function useQuery() {
  const u = new URL(window.location.href);
  const role = (u.searchParams.get('role') === 'responder') ? 'responder' : 'initiator';
  const a2aUrl = u.searchParams.get('a2a') || '';
  const tasksUrl = u.searchParams.get('tasks') || '';
  return { role, a2aUrl, tasksUrl };
}

// UI helpers
const Pill: React.FC<{children:React.ReactNode}> = ({ children }) => <span className="pill">{children}</span>;
const Button: React.FC<{children:React.ReactNode; onClick?:()=>void; disabled?:boolean; variant?:'default'|'primary'|'ghost'}> = ({children,onClick,disabled,variant='default'}) => {
  const cls = variant==='primary' ? 'btn primary' : variant==='ghost' ? 'btn ghost' : 'btn';
  return <button className={cls} onClick={onClick} disabled={disabled}>{children}</button>;
};

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
  const { role, a2aUrl, tasksUrl } = useQuery();
  const endpoint = useMemo(() => a2aUrl, [a2aUrl]);
  const a2a = useMemo(() => new A2AClient(endpoint), [endpoint]);
  const [status, setStatus] = useState<A2AStatus | 'initializing'>('initializing');
  const [taskId, setTaskId] = useState<string | undefined>();
  const [facts, setFacts] = useState<Fact[]>([]);
  const [agentMode, setAgentMode] = useState<'off'|'suggest'|'auto'>('suggest');
  const [hudNow, setHudNow] = useState<string>('');
  const [hudLog, setHudLog] = useState<string[]>([]);
  const [openQuestion, setOpenQuestion] = useState<{ qid:string; prompt:string; required?:boolean; placeholder?:string } | null>(null);
  const [compose, setCompose] = useState<{ composeId:string; text:string; attachments?:AttachmentMeta[] } | null>(null);
  const [sending, setSending] = useState(false);

  const journalRef = useRef(new Journal());
  const harnessRef = useRef<PlannerHarness<{mode:'off'|'suggest'|'auto'}> | null>(null);
  if (!harnessRef.current) {
    harnessRef.current = new PlannerHarness<{mode:'off'|'suggest'|'auto'}>(
      journalRef.current,
      SimpleDemoPlanner,
      async function* (parts, opts) { for await (const f of a2a.messageStreamParts(parts, { taskId, messageId: opts.messageId })) yield f; },
      { mode: agentMode },
      { myAgentId: role, otherAgentId: role==='initiator'?'responder':'initiator' },
      {
        onHud: (ev) => setHudNow(ev.label || ev.phase),
        onHudFlush: (evs) => setHudLog(prev => [...prev, ...evs.map(e => `${e.phase}${e.label?`: ${e.label}`:''}`)]),
        onComposerOpened: (ci) => setCompose(ci),
        onComposerCleared: () => setCompose(null),
        onQuestion: (q) => setOpenQuestion(q),
      }
    );
  }

  // keep harness config in sync
  useEffect(() => {
    // recreate harness when agentMode changes
    harnessRef.current = new PlannerHarness<{mode:'off'|'suggest'|'auto'}>(
      journalRef.current,
      SimpleDemoPlanner,
      async function* (parts, opts) { for await (const f of a2a.messageStreamParts(parts, { taskId, messageId: opts.messageId })) yield f; },
      { mode: agentMode },
      { myAgentId: role, otherAgentId: role==='initiator'?'responder':'initiator' },
      {
        onHud: (ev) => setHudNow(ev.label || ev.phase),
        onHudFlush: (evs) => setHudLog(prev => [...prev, ...evs.map(e => `${e.phase}${e.label?`: ${e.label}`:''}`)]),
        onComposerOpened: (ci) => setCompose(ci),
        onComposerCleared: () => setCompose(null),
        onQuestion: (q) => setOpenQuestion(q),
      }
    );
  }, [agentMode, a2a, taskId, role]);

  // Subscribe journal → React state
  useEffect(() => {
    const j = journalRef.current;
    const unsub = j.onAnyNewEvent(() => {
      const all = j.facts().slice();
      setFacts(all);
      // also update status from journal so UI stays in sync even when harness streams
      for (let i = all.length - 1; i >= 0; --i) {
        const f = all[i];
        if (f.type === 'status_changed') { setStatus(f.a2a); break; }
      }
    });
    const initial = j.facts().slice();
    setFacts(initial);
    for (let i = initial.length - 1; i >= 0; --i) {
      const f = initial[i];
      if (f.type === 'status_changed') { setStatus(f.a2a); break; }
    }
    return () => { try { unsub(); } catch {} };
  }, []);

  // Backchannel for responder
  useEffect(() => {
    if (!endpoint) return;
    if (role === 'responder' && tasksUrl) {
      const es = new EventSource(tasksUrl);
      es.onmessage = (ev) => {
        try {
          const payload = JSON.parse(ev.data);
          const msg: ServerEvent = payload.result;
          if (msg.type === 'subscribe') {
            // Resubscribe to this task
            const ac = new AbortController();
            (async () => {
              for await (const frame of a2a.tasksResubscribe(msg.taskId, ac.signal)) {
                ingestFrame(frame);
              }
            })();
          }
        } catch {}
      };
      es.onerror = () => { /* ignore, browser reconnects */ };
      return () => { try { es.close(); } catch {} };
    }
  }, [endpoint, tasksUrl, role, a2a]);

  // Maintain A2A subscription for initiator once taskId is known
  useEffect(() => {
    if (!endpoint) return;
    if (role !== 'initiator') return;
    if (!taskId) return;
    const ac = new AbortController();
    (async () => {
      try {
        for await (const frame of a2a.tasksResubscribe(taskId, ac.signal)) {
          ingestFrame(frame);
        }
      } catch {}
    })();
    return () => { try { ac.abort(); } catch {} };
  }, [endpoint, role, taskId, a2a]);

  // Helper to ingest frame into journal + status
  function ingestFrame(frame: FrameResult) {
    harnessRef.current?.ingestA2AFrame(frame);
    if ('kind' in frame) {
      if (frame.kind === 'task') {
        setTaskId(frame.id);
      } else if (frame.kind === 'status-update') {
        if (frame.status.state === 'input-required') harnessRef.current?.kick();
      } else if (frame.kind === 'message') {
        harnessRef.current?.kick();
      }
    }
  }

  // Startup: no server events → initiator has to start
  // We kick planner when app comes into our turn via status updates.

  // UI actions
  async function approveAndSend() {
    if (!compose || sending) return;
    setSending(true);
    try {
      await harnessRef.current?.approveAndSend(compose.composeId, 'turn');
    } finally {
      setSending(false);
    }
  }
  async function handleManualSend(text: string, finality: Finality) {
    // Route through the journal: append compose_intent, then approve & send
    const j = journalRef.current;
    const composeId = `c-${crypto.randomUUID()}`;
    j.append({ type: 'compose_intent', composeId, text } as ProposedFact, 'private');
    await harnessRef.current?.approveAndSend(composeId, finality);
  }
  function sendWhisper(text: string) {
    const t = text.trim(); if (!t) return;
    harnessRef.current?.addUserGuidance(t);
  }
  function answerQuestion(qid:string, text:string) {
    harnessRef.current?.answerQuestion(qid, text);
    setOpenQuestion(null);
  }

  // Render transcript from facts
  const items = facts;
  const currentStatus: A2AStatus | 'initializing' = useMemo(() => {
    for (let i = items.length - 1; i >= 0; --i) {
      const f = items[i];
      if (f.type === 'status_changed') return f.a2a;
    }
    return 'initializing';
  }, [items]);
  const sentComposeIds = useMemo(() => {
    const s = new Set<string>();
    for (const f of items) if (f.type === 'remote_sent' && f.composeId) s.add(f.composeId);
    return s;
  }, [items]);

  return (
    <div className="wrap">
      <div className="card">
        <div className="row">
          <div><strong>Role:</strong> <span className="pill">{role === 'initiator' ? 'Initiator' : 'Responder'}</span></div>
          <div className="pill">Status: {currentStatus}</div>
          <div className="row" style={{marginLeft:'auto', gap:8}}>
            <label className="small">Agent
              <select value={agentMode} onChange={e => setAgentMode(e.target.value as 'off'|'suggest'|'auto')} style={{marginLeft:6}}>
                <option value="off">Off</option>
                <option value="suggest">Suggest</option>
                <option value="auto">Auto</option>
              </select>
            </label>
          </div>
        </div>
        <div className="small muted" style={{marginTop:6, display:'flex', alignItems:'center', gap:8}}>
          <span className="dot" />
          <span style={{flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap'}}>{hudNow || 'Agent idle'}</span>
          <details>
            <summary className="small">HUD log</summary>
            <div className="small muted" style={{marginTop:6, maxHeight:120, overflow:'auto'}}>
              {hudLog.length ? hudLog.map((l, i) => <div key={i}>{l}</div>) : <div>(empty)</div>}
            </div>
          </details>
        </div>
      </div>

      <div className="card">
        <div className="transcript">
          {!items.length && <div className="small muted">No events yet.</div>}
          {items.map((f, i) => {
            if (f.type === 'remote_received' || f.type === 'remote_sent') {
              const isMe = f.type === 'remote_sent';
              return (
                <div key={f.id} className={'bubble ' + (isMe ? 'me' : 'them')}>
                  <div className="small muted">{isMe ? 'Our agent' : 'Payer agent'}</div>
                  <div className="text">{f.text}</div>
                  {Array.isArray(f.attachments) && f.attachments.length > 0 && (
                    <div className="attachments small">
                      {f.attachments.map((a:AttachmentMeta) => {
                        // Resolve bytes to a blob URL if known
                        const added = [...items].reverse().find(x => x.type === 'attachment_added' && x.name === a.name);
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
            // Private stripes
            if (f.type === 'tool_call' || f.type === 'tool_result' || f.type === 'user_guidance' || f.type === 'agent_question' || f.type === 'agent_answer' || f.type === 'compose_intent') {
              // Hide draft if it has already been sent (correlate by composeId)
              if (f.type === 'compose_intent' && sentComposeIds.has(f.composeId)) {
                return <div key={f.id} className="small muted" style={{display:'none'}} />;
              }
              const stripeClass =
                f.type === 'tool_call' || f.type === 'tool_result' ? 'stripe tool' :
                f.type === 'user_guidance' ? 'stripe whisper' :
                f.type === 'agent_question' ? 'stripe question' :
                f.type === 'agent_answer' ? 'stripe answer' :
                'stripe draft';
              return (
                <div key={f.id} className={'private ' + stripeClass}>
                  <div className="stripe-head">
                    {f.type === 'tool_call' && 'Private • Tool Call'}
                    {f.type === 'tool_result' && 'Private • Tool Result'}
                    {f.type === 'user_guidance' && 'Private • Whisper'}
                    {f.type === 'agent_question' && 'Private • Agent Question'}
                    {f.type === 'agent_answer' && 'Private • Answer'}
                    {f.type === 'compose_intent' && 'Private • Draft'}
                  </div>
                  <div className="stripe-body">
                    {f.type === 'tool_call' && <div className="text small"><code>{f.name}</code> {JSON.stringify(f.args)}</div>}
                    {f.type === 'tool_result' && <div className="text small">{f.ok ? 'ok' : 'error'} {f.error ? `• ${f.error}`: ''}</div>}
                    {f.type === 'user_guidance' && <div className="text">{f.text}</div>}
                    {f.type === 'agent_answer' && <div className="text">{f.text}</div>}
                    {f.type === 'agent_question' && (
                      <QuestionInline
                        q={f}
                        onSubmit={(t) => answerQuestion(f.qid, t)}
                        onSkip={() => answerQuestion(f.qid, '')}
                      />
                    )}
                    {f.type === 'compose_intent' && (
                      <div>
                        <div className="text">{f.text}</div>
                        {Array.isArray(f.attachments) && f.attachments.length>0 && (
                          <div className="attachments small" style={{marginTop:8}}>
                            Would attach:&nbsp;
                            {f.attachments.map((a:AttachmentMeta) => <span key={a.name} className="pill">{a.name}</span>)}
                          </div>
                        )}
                        <div className="row" style={{marginTop:8, gap:8}}>
                          <Button onClick={approveAndSend} disabled={sending || status!=='input-required'}>{sending ? 'Sending…' : 'Approve & Send'}</Button>
                          {/* Leave Dismiss for future */}
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            }
            if (f.type === 'status_changed') {
              // keep it invisible; or render tiny line for debugging
              return <div key={f.id} className="small muted" style={{display:'none'}} />;
            }
            if (f.type === 'attachment_added') {
              return <div key={f.id} className="small muted" style={{display:'none'}} />;
            }
            return <div key={f.id} />;
          })}
        </div>
        {/* Persistent manual composer, always visible; button enables when it's our turn */}
        {(() => {
          const initiatorCanStart = role === 'initiator' && (currentStatus === 'initializing' || currentStatus === 'submitted');
          const canSendManual = currentStatus === 'input-required' || initiatorCanStart;
          const hint = !endpoint
            ? 'No endpoint configured — open from Control Plane links.'
            : (currentStatus === 'completed' ? 'Conversation completed.'
              : currentStatus === 'canceled' ? 'Conversation canceled.'
              : currentStatus === 'failed' ? 'Conversation failed.'
              : currentStatus === 'input-required' ? 'You may send now.'
              : initiatorCanStart ? 'First send will start the conversation.'
              : 'Not your turn — waiting for the other side.');
          return (
            <ManualComposer
              disabled={!endpoint || !canSendManual}
              hint={hint}
              onSend={handleManualSend}
            />
          );
        })()}
      </div>

      <div className="card">
        <div className="row" style={{alignItems:'center'}}>
          <Whisper onSend={sendWhisper} />
        </div>
        <div className="small muted" style={{marginTop:6}}>
          {currentStatus === 'input-required' ? 'You may send now (composer drafts appear as a private “Draft” box).' :
            currentStatus === 'completed' ? 'Conversation completed.' :
            currentStatus === 'failed' ? 'Conversation failed.' :
            currentStatus === 'canceled' ? 'Conversation canceled.' :
            'Waiting for the other side to end their turn.'}
        </div>
      </div>
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
        <Button variant="ghost" onClick={() => setOpen(v=>!v)}>{open ? 'Hide' : 'Open'}</Button>
      </div>
      {open && (
        <div className="row" style={{marginTop:6}}>
          <input className="input" style={{flex:1}} placeholder="e.g., Emphasize failed PT and work impact" value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={(e)=>{ if (e.key==='Enter') { onSend(txt); setTxt(''); } }} />
          <Button onClick={()=>{ onSend(txt); setTxt(''); }}>Send whisper</Button>
        </div>
      )}
    </div>
  );
}

function QuestionInline({ q, onSubmit, onSkip }:{ q:{prompt:string; placeholder?:string}; onSubmit:(t:string)=>void; onSkip:()=>void }) {
  const [txt, setTxt] = useState('');
  return (
    <div>
      <div className="text" style={{marginBottom:6}}>{q.prompt}</div>
      <div className="row">
        <input className="input" style={{flex:1}} placeholder={q.placeholder || 'Type your answer'} value={txt} onChange={e=>setTxt(e.target.value)} onKeyDown={(e)=>{ if (e.key==='Enter') onSubmit(txt); }} />
        <Button onClick={()=>onSubmit(txt || '')}>Answer</Button>
        <Button variant="ghost" onClick={onSkip}>Skip</Button>
      </div>
      <div className="small muted" style={{marginTop:4}}>Private: your answer isn’t sent to the payer.</div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
