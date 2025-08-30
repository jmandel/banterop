import React from 'react';
import { useAppStore } from '../../state/store';

const DEFAULTS = { systemAppend: '', targetWords: 0 } as const;

export type LlmDrafterDraft = {
  systemAppend: string;
  targetWords: number;
};

export function dehydrateLLM(full: LlmDrafterDraft) {
  const seed: any = { v: 1 };
  if (full.systemAppend?.trim()) seed.systemAppend = full.systemAppend.trim();
  if (full.targetWords) seed.targetWords = full.targetWords;
  return seed;
}

export async function hydrateLLM(seed: any): Promise<{ config: LlmDrafterDraft; ready: boolean }> {
  const systemAppend = String(seed?.systemAppend || '');
  const targetWords = Math.max(0, Math.min(1000, Number(seed?.targetWords || 0)));
  return { config: { systemAppend, targetWords }, ready: true };
}

export function LLMDrafterSetup() {
  const pid = 'llm-drafter';
  const draft = useAppStore(s => s.plannerSetup.byPlanner[pid]?.draft) || (DEFAULTS as LlmDrafterDraft);
  const setDraft = useAppStore(s => s.setSetupDraft);
  const setMeta = useAppStore(s => s.setSetupMeta);
  const ready = useAppStore(s => !!s.readyByPlanner[pid]);

  function update(next: Partial<LlmDrafterDraft>) {
    const full = { ...draft, ...next } as LlmDrafterDraft;
    const n = Number(full.targetWords || 0);
    const valid = Number.isFinite(n) && n >= 0 && (n === 0 || (n >= 10 && n <= 1000));
    setDraft(pid, full);
    setMeta(pid, {
      valid,
      summary: 'LLM Drafter ready',
      seed: valid ? dehydrateLLM(full) : undefined
    });
  }

  // Auto-apply defaults if planner not ready and no prior config
  React.useEffect(() => {
    if (ready) return;
    const s = useAppStore.getState();
    const row = s.plannerSetup.byPlanner[pid];
    const hasApplied = !!row?.lastApplied;
    if (!hasApplied) {
      try {
        s.setSetupDraft(pid, DEFAULTS as any);
        s.setSetupMeta(pid, { valid: true, summary: 'LLM Drafter ready', seed: dehydrateLLM(DEFAULTS as any) });
        s.applySetup(pid);
      } catch {}
    }
  }, [ready]);

  return (
    <div style={{display:'grid', gap:10, maxWidth:680}}>
      <label className="small">System prompt (append)</label>
      <input className="input" value={draft.systemAppend} onChange={e => update({ systemAppend: e.target.value })} />

      <label className="small">Target word count</label>
      <input className="input" value={String(draft.targetWords)} onChange={e => update({ targetWords: Number(e.target.value||0) })} />
      <div className="small muted">0 disables; otherwise 10–1000</div>
    </div>
  );
}
