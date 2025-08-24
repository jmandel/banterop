import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useStore } from '../state/store';
import type { A2APart } from '../../shared/a2a-types';

type Role = 'initiator'|'responder';

function useQuery() {
  const u = new URL(window.location.href);
  const role = (u.searchParams.get('role') === 'responder') ? 'responder' : 'initiator';
  const a2aUrl = u.searchParams.get('a2a') || '';
  const tasksUrl = u.searchParams.get('tasks') || '';
  return { role, a2aUrl, tasksUrl };
}

function attachmentHrefFromBase64(name:string, mimeType:string, b64:string) {
  try {
    const bin = atob(b64);
    const arr = new Uint8Array(bin.length);
    for (let i=0;i<bin.length;i++) arr[i] = bin.charCodeAt(i);
    const blob = new Blob([arr], { type: mimeType || 'application/octet-stream' });
    return URL.createObjectURL(blob);
  } catch { return null; }
}

function App() {
  const { role, a2aUrl, tasksUrl } = useQuery();
  const configure = useStore(s => s.configure);
  const taskId = useStore(s => s.taskId);
  const status = useStore(s => s.status);
  const journal = useStore(s => s.journal);
  const sendManual = useStore(s => s.sendManual);
  const cancelTask = useStore(s => s.cancelTask);
  const startTicks = useStore(s => s.startTicks);
  const bootResponder = useStore(s => s.bootResponder);
  const sending = useStore(s => s.sending);

  useEffect(() => {
    if (!a2aUrl) return;
    configure(a2aUrl, role as Role);
    // If we already have a task (e.g., reload/persist), ensure ticks run immediately
    if (taskId) startTicks(taskId);
    if (role === 'responder') {
      // Watch pair control-plane and adopt new responder task IDs on subscribe
      try {
        // Derive pairId from a2aUrl or tasksUrl
        let pairId: string | undefined;
        if (a2aUrl) {
          const u = new URL(a2aUrl);
          const parts = u.pathname.split('/').filter(Boolean);
          const ix = parts.findIndex(p => p === 'bridge');
          if (ix !== -1 && parts.length > ix + 1) pairId = parts[ix + 1];
        }
        if (!pairId && tasksUrl) {
          const u = new URL(tasksUrl);
          const parts = u.pathname.split('/').filter(Boolean);
          const ix = parts.findIndex(p => p === 'pairs');
          if (ix !== -1 && parts.length > ix + 1) pairId = parts[ix + 1];
        }
        if (pairId) bootResponder(pairId);
      } catch {}
    }
  }, [a2aUrl, tasksUrl, role]);

  const [text, setText] = useState('');
  const [finality, setFinality] = useState<'none'|'turn'|'conversation'>('turn');

  async function sendCurrent() {
    if (!text.trim()) return;
    await useStore.getState().sendManual(text, finality);
    setText('');
  }

  const items = journal.facts;
  const sentComposeIds = useMemo(() => {
    const s = new Set<string>();
    for (const f of items) if ((f as any).type === 'remote_sent' && (f as any).composeId) s.add((f as any).composeId);
    return s;
  }, [items]);

  const canSend = (status === 'input-required') || (role === 'initiator' && status === 'waiting-for-task');

  return (
    <div className="wrap">
      <div className="card">
        <div className="row">
          <div><strong>Role:</strong> <span className="pill">{role === 'initiator' ? 'Initiator' : 'Responder'}</span></div>
          <div className="pill">Status: {taskId ? status : 'Waiting for new task'}</div>
          {taskId && <div className="pill">Task: {taskId}</div>}
          <div style={{marginLeft:'auto'}} />
          {role==='initiator' && taskId && <button className="btn" onClick={()=>cancelTask()}>Cancel task</button>}
        </div>
      </div>

      <div className="card">
        <div className="transcript">
          {!items.length && <div className="small muted">No events yet.</div>}
          {items.map((f:any) => {
            if (f.type === 'remote_received' || f.type === 'remote_sent') {
              const isMe = f.type === 'remote_sent';
              return (
                <div key={f.id} className={'bubble ' + (isMe ? 'me' : 'them')}>
                  <div className="small muted">{isMe ? 'Our agent' : 'Other agent'}</div>
                  <div className="text">{f.text}</div>
                  {Array.isArray(f.attachments) && f.attachments.length > 0 && (
                    <div className="attachments small">
                      {f.attachments.map((a:any) => {
                        const added = [...items].reverse().find((x:any) => x.type==='attachment_added' && x.name === a.name);
                        const href = added ? attachmentHrefFromBase64(a.name, added.mimeType, added.bytes) : null;
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
            return <div key={f.id} />;
          })}
        </div>
        <div className="row" style={{marginTop:10, gap:8, alignItems:'center'}}>
          <input
            className="input"
            style={{flex:1}}
            placeholder={canSend ? 'Type a message to the other side…' : 'Not your turn yet…'}
            value={text}
            onChange={e=>setText(e.target.value)}
            onKeyDown={(e)=>{ if (e.key==='Enter') { e.preventDefault(); if (canSend) void sendCurrent(); } }}
            disabled={!canSend || sending}
          />
          <select
            value={finality}
            onChange={(e)=>setFinality(e.target.value as any)}
            disabled={sending}
            title="Finality hint"
          >
            <option value="none">no finality</option>
            <option value="turn">end turn → flip</option>
            <option value="conversation">end conversation</option>
          </select>
          <button
            className="btn"
            onClick={()=>{ if (canSend) void sendCurrent(); }}
            disabled={!canSend || sending}
            aria-disabled={!canSend || sending}
            title={!canSend ? 'Not your turn to send' : 'Send message'}
          >
            {sending?'Sending…':'Send'}
          </button>
        </div>
        <div className="small muted" style={{marginTop:6}}>
          {status === 'input-required' ? 'You may send now.' :
            status === 'working' ? 'Waiting for the other side.' :
            status === 'waiting-for-task' ? 'First send will start the conversation.' :
            status === 'completed' ? 'Conversation completed.' :
            status === 'failed' ? 'Conversation failed.' :
            status === 'canceled' ? 'Conversation canceled.' :
            'Idle.'}
        </div>
      </div>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(<App />);
