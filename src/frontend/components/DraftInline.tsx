import React, { useState } from 'react';
import type { AttachmentMeta } from '../../shared/journal-types';
import { useAppStore } from '../state/store';
import { attachmentHrefFromBase64 } from './attachments';
import { NextStateSelect } from './NextStateSelect';
import { Markdown } from './Markdown';
import type { A2ANextState } from '../../shared/a2a-types';

export function DraftInline({ composeId, text, attachments }:{ composeId:string; text:string; attachments?: AttachmentMeta[] }) {
  const [nextState, setNextState] = useState<A2ANextState>('working');
  const [sending, setSending] = useState(false);
  const err = useAppStore(s => s.sendErrorByCompose.get(composeId));
  const pid = useAppStore(s => s.plannerId);
  const ready = useAppStore(s => !!s.readyByPlanner[s.plannerId]);
  const facts = useAppStore(s => s.facts);
  async function approve() {
    setSending(true);
    try { await useAppStore.getState().sendCompose(composeId, nextState); }
    finally { setSending(false); }
  }
  async function retry() { await approve(); }
  function regenerate() {
    try { useAppStore.getState().dismissCompose(composeId); } catch {}
    // Nudge controller by changing configByPlanner identity (no-op clone)
    useAppStore.setState((s: any) => {
      const curr = (s.configByPlanner || {})[pid];
      return { configByPlanner: { ...(s.configByPlanner || {}), [pid]: curr ? { ...curr } : {} } };
    });
  }
  return (
    <div>
      <Markdown text={text} />
      {Array.isArray(attachments) && attachments.length > 0 && (
        <div className="attachments small" style={{ marginTop: 6 }}>
          {attachments.map((a:AttachmentMeta) => {
            const added = facts.find(x => x.type === 'attachment_added' && (x as any).name === a.name);
            const href = added && added.type === 'attachment_added' ? attachmentHrefFromBase64(a.name, (added as any).mimeType, (added as any).bytes) : null;
            return (
              <a key={a.name} className="att" href={href || '#'} target="_blank" rel="noreferrer" onClick={e => { if (!href) e.preventDefault(); }}>
                📎 {a.name} <span className="muted">({a.mimeType || 'application/octet-stream'})</span>
              </a>
            );
          })}
        </div>
      )}
      <div className="row" style={{marginTop:8, gap:8}}>
        <NextStateSelect value={nextState as any} onChange={(v)=>setNextState(v as any)} order={['working','input-required','completed']} />
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
