import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { AttachmentMeta, Fact } from '../../shared/journal-types';
import type { A2APart } from '../../shared/a2a-types';
import { useAppStore } from '../state/store';
import { A2AAdapter } from '../transports/a2a-adapter';
import { MCPAdapter } from '../transports/mcp-adapter';

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
            useAppStore.getState().setTaskId(msg.taskId);
            useAppStore.getState().startTicks();
            // also fetch initial snapshot once
            void useAppStore.getState().fetchAndIngest();
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
    try { await useAppStore.getState().approveAndSend(composeId, finality); }
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
  const sentComposeIds = useMemo(() => {
    const s = new Set<string>(); for (const f of facts) if (f.type==='remote_sent' && f.composeId) s.add(f.composeId); return s;
  }, [facts]);

  const initiatorCanStart = role === 'initiator' && !taskId;
  const canSendManual = true; // manual composer always available; transport decides turn

  return (
    <div className="wrap">
      <div className="card">
        <div className="row">
          <div><strong>Role:</strong> <span className="pill">{role === 'initiator' ? 'Initiator' : 'Responder'}</span></div>
          <div className="pill">Status: {uiStatus}</div>
          <div className="pill">Task: {taskId || '—'}</div>
          {role==='initiator' && (
            <button className="btn" onClick={clearTask} disabled={!taskId}>Clear task</button>
          )}
        </div>
      </div>

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
              if (f.type === 'compose_intent' && sentComposeIds.has(f.composeId)) {
                return <div key={f.id} style={{display:'none'}} />;
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
          hint={!canSendManual ? 'Not your turn' : (initiatorCanStart ? 'First send will start a conversation' : undefined)}
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

function DraftInline({ composeId, text }:{ composeId:string; text:string }) {
  const sending = false;
  async function approve() {
    await useAppStore.getState().approveAndSend(composeId, 'turn');
  }
  return (
    <div>
      <div className="text">{text}</div>
      <div className="row" style={{marginTop:8, gap:8}}>
        <button className="btn" onClick={()=>void approve()} disabled={sending}>{sending ? 'Sending…' : 'Approve & Send'}</button>
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

function ManualComposer({ disabled, hint, onSend, sending }:{ disabled:boolean; hint?:string; onSend:(t:string, f:'none'|'turn'|'conversation')=>Promise<void>|void; sending:boolean }) {
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
          placeholder={disabled ? 'Not your turn yet…' : 'Type a message to the other side…'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void send(); } }}
          disabled={sending}
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
        .manual-composer input, .manual-composer select, .manual-composer button {
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
