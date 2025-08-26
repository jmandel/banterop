import type { A2APart } from '../shared/a2a-types';

export function validateParts(parts: A2APart[]): { ok:true } | { ok:false; reason:string } {
  for (const p of parts) {
    if (!p || typeof (p as any).kind !== 'string') return { ok:false, reason:'part missing kind' };
    if (p.kind === 'file') {
      const f:any = (p as any).file;
      const hasBytes = typeof f?.bytes === 'string';
      const hasUri = typeof f?.uri === 'string';
      if (hasBytes && hasUri) return { ok:false, reason:'file part must not include both bytes and uri' };
      if (!hasBytes && !hasUri) return { ok:false, reason:'file part requires bytes or uri' };
    } else if (p.kind === 'text') {
      if (typeof (p as any).text !== 'string') return { ok:false, reason:'text part requires text' };
    } else if (p.kind === 'data') {
      if (typeof (p as any).data !== 'object' || (p as any).data === null) return { ok:false, reason:'data part requires object' };
    } else {
      return { ok:false, reason:`unsupported part kind` };
    }
  }
  return { ok:true };
}

