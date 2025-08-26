import type { A2APart, A2AMessage, A2ATask, A2AStatusUpdate } from './a2a-types';
import type { ProposedFact, AttachmentMeta } from './journal-types';
import { partsText } from './a2a-helpers';

// Accepts any of the three frame shapes the client sees:
type Frame = A2ATask | A2AStatusUpdate | { kind:'message'; role:'user'|'agent'; parts:A2APart[]; messageId?:string };

export function a2aToFacts(frame: Frame): ProposedFact[] {
  const out: ProposedFact[] = [];

  // (1) Task snapshot
  if ((frame as A2ATask).kind === 'task') {
    const t = frame as A2ATask;
    const st = t.status?.state || 'submitted';
    out.push({ type:'status_changed', a2a: st } as ProposedFact);
    for (const m of t.history || []) out.push(...messageToFacts(m));
    if (t.status?.message) out.push(...messageToFacts(t.status.message));
    return out;
  }

  // (2) Status-update
  if ((frame as A2AStatusUpdate).kind === 'status-update') {
    const su = frame as A2AStatusUpdate;
    out.push({ type:'status_changed', a2a: su.status?.state || 'submitted' } as ProposedFact);
    if (su.status?.message) out.push(...messageToFacts(su.status.message));
    return out;
  }

  // (3) Raw message frame
  if ((frame as any).kind === 'message') {
    const m = frame as any as A2AMessage;
    out.push(...messageToFacts(m));
    return out;
  }

  return out;
}

function messageToFacts(m: A2AMessage): ProposedFact[] {
  const parts = m.parts || [];
  const text = partsText(parts);
  const messageId = m.messageId || crypto.randomUUID();

  // Inline attachments (bytes only)
  const atts: AttachmentMeta[] = [];
  const proposed: ProposedFact[] = [];

  for (const p of parts) {
    if (p.kind === 'file' && 'bytes' in (p as any).file) {
      const bytes = String((p as any).file.bytes || '');
      const name = String((p as any).file.name || `file-${Math.random().toString(36).slice(2,7)}.bin`);
      const mimeType = String((p as any).file.mimeType || 'application/octet-stream');
      proposed.push({ type:'attachment_added', name, mimeType, bytes, origin:'inbound' } as ProposedFact);
      const decodedLen = Math.floor((bytes.length * 3) / 4) - (bytes.endsWith('==') ? 2 : bytes.endsWith('=') ? 1 : 0);
      atts.push({ name, mimeType, origin:'inbound', size: decodedLen });
    }
  }

  if (m.role === 'agent') {
    proposed.push({ type:'remote_received', messageId, text, attachments: atts.length ? atts : undefined } as ProposedFact);
  } else {
    proposed.push({ type:'remote_sent', messageId, text, attachments: atts.length ? atts : undefined } as ProposedFact);
  }
  return proposed;
}
