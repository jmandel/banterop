import type { A2APart, A2AMessage, A2ATask, A2AStatusUpdate } from './a2a-types';
import type { ProposedFact, AttachmentMeta } from './journal-types';
import { partsText } from './a2a-helpers';
import { b64ByteLength } from './codec';

// Accepts any of the three frame shapes the client sees:
type Frame = A2ATask | A2AStatusUpdate | { kind:'message'; role:'user'|'agent'; parts:A2APart[]; messageId?:string };

export function a2aToFacts(frame: Frame): ProposedFact[] {
  const out: ProposedFact[] = [];

  // (1) Task snapshot
  if ((frame as A2ATask).kind === 'task') {
    const t = frame as A2ATask;
    // Emit messages first (history, then current status message), then the status change
    for (const m of t.history || []) out.push(...messageToFacts(m));
    if (t.status?.message) out.push(...messageToFacts(t.status.message));
    const st = t.status?.state || 'submitted';
    out.push({ type:'status_changed', a2a: st } as ProposedFact);
    return out;
  }

  // (2) Status-update
  if ((frame as A2AStatusUpdate).kind === 'status-update') {
    const su = frame as A2AStatusUpdate;
    // Show message first, then status — improves perceived ordering in logs
    if (su.status?.message) out.push(...messageToFacts(su.status.message));
    out.push({ type:'status_changed', a2a: su.status?.state || 'submitted' } as ProposedFact);
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
      const f: any = (p as any).file || {};
      const bytes = String(f.bytes || '');
      const name = String(f.name || `file-${Math.random().toString(36).slice(2,7)}.bin`);
      const mimeType = String(f.mimeType || 'application/octet-stream');
      proposed.push({ type:'attachment_added', name, mimeType, bytes, origin:'inbound' } as ProposedFact);
      const size = typeof f.size === 'number' && Number.isFinite(f.size)
        ? Number(f.size)
        : b64ByteLength(bytes);
      atts.push(size != null ? { name, mimeType, origin:'inbound', size } : { name, mimeType, origin:'inbound' });
    }
  }

  if (m.role === 'agent') {
    proposed.push({ type:'remote_received', messageId, text, attachments: atts.length ? atts : undefined } as ProposedFact);
  } else {
    proposed.push({ type:'remote_sent', messageId, text, attachments: atts.length ? atts : undefined } as ProposedFact);
  }
  return proposed;
}

// (moved) b64ByteLength now lives in shared/codec.ts
