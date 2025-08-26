import type { A2APart } from './a2a-types';
import { A2A_EXT_URL } from './core';

export function partsText(parts?: A2APart[]): string {
  // Preserve user-intended leading/trailing whitespace; callers can trim if desired.
  return (parts ?? []).filter(p => p.kind === 'text').map(p => (p as any).text as string).join('\n');
}

export function readExtFromParts(parts?: A2APart[]): any | null {
  for (const p of parts || []) {
    const meta:any = (p as any).metadata || {};
    const block = meta?.[A2A_EXT_URL];
    if (block) return block;
  }
  return null;
}

export function uniqueName(name: string, existing: Set<string>): string {
  if (!existing.has(name)) return name;
  const stem = name.replace(/\.[^./]+$/, '');
  const ext = (name.match(/\.[^./]+$/) || [''])[0];
  let i = 2;
  while (existing.has(`${stem} (${i})${ext}`)) i++;
  return `${stem} (${i})${ext}`;
}
