import { create } from 'zustand';
import type { PlannerConfigStore } from '../../planner/config/store';
import type { ConfigSnapshot, FieldState } from '../../planner/config/types';

async function listModels(llm: any): Promise<string[]> {
  try {
    const xs = await llm?.listModels?.();
    if (Array.isArray(xs) && xs.length) return xs.map(String);
  } catch {}
  return ['openai/gpt-oss-120b:nitro'];
}

export function createLLMDrafterConfigStore(opts: { llm: any; initial?: any }): PlannerConfigStore {
  const store = create<PlannerConfigStore & { _initial?: any; _mounted: boolean }>((set, get) => {
    const fields: FieldState[] = [
      { key: 'model', type: 'select', label: 'Model', value: String(opts.initial?.model || ''), options: [], pending: true },
      { key: 'systemAppend', type: 'text', label: 'System prompt (append)', value: String(opts.initial?.systemAppend || ''), placeholder: 'Optional: appended to built-in system prompt' },
      { key: 'targetWords', type: 'text', label: 'Target word count', value: String(opts.initial?.targetWords ?? 0), placeholder: '0 (no target)', help: 'Aim near this length; set 0 to disable.' },
    ];
    const snap: ConfigSnapshot = { fields, canSave: false, pending: true, dirty: false };

    (async () => {
      const models = await listModels(opts.llm);
      if (!(get() as any)._mounted) return;
      const f = get().snap.fields.find(x => x.key === 'model')!;
      f.options = models.map(m => ({ value: m, label: m }));
      if (!f.value) f.value = models[0];
      f.pending = false;
      const anyPending = get().snap.fields.some(x => x.pending);
      const anyError = get().snap.fields.some(x => x.error);
      set(s => ({ snap: { ...s.snap, fields: [...s.snap.fields], pending: anyPending, dirty: true, canSave: !anyPending && !anyError } }));
    })();

    function setField(key: string, value: unknown) {
      const f = get().snap.fields.find(x => x.key === key)!;
      f.value = value;
      if (key === 'targetWords') {
        const n = Number(value);
        if (!Number.isFinite(n) || n < 0) {
          f.error = 'Enter 0 to disable, or a positive number.';
        } else if (n !== 0 && (n < 10 || n > 1000)) {
          f.error = 'Enter a number between 10 and 1000, or 0 to disable.';
        } else {
          f.error = null;
        }
      }
      const anyPending = get().snap.fields.some(x => x.pending);
      const anyError = get().snap.fields.some(x => x.error);
      set(s => ({ snap: { ...s.snap, fields: [...s.snap.fields], pending: anyPending, dirty: true, canSave: !anyPending && !anyError } }));
    }

    function exportApplied() {
      const val = (k: string) => get().snap.fields.find(x => x.key === k)!.value;
      const tw = Number(val('targetWords') || 0);
      const model = String(val('model') || '');
      const applied = {
        model,
        systemAppend: String(val('systemAppend') || ''),
        targetWords: Number.isFinite(tw) ? tw : 0,
      };
      return { applied, ready: true };
    }

    function destroy() { (get() as any)._mounted = false; }

    return { snap, setField, exportApplied, destroy, _mounted: true } as any;
  });

  return {
    get snap() { return store.getState().snap; },
    setField: (k, v) => store.getState().setField(k, v),
    exportApplied: () => store.getState().exportApplied(),
    destroy: () => { try { store.getState().destroy(); } catch {} try { (store as any).destroy?.(); } catch {} },
    subscribe: (listener: () => void) => (store as any).subscribe(listener),
  };
}

// Attach companions onto the existing planner object
import { LLMDrafterPlanner } from './llm-drafter';
;(LLMDrafterPlanner as any).createConfigStore = createLLMDrafterConfigStore;
;(LLMDrafterPlanner as any).toHarnessCfg = (applied: any) => ({
  endpoint: applied?.endpoint,
  model: String(applied?.model || ''),
  temperature: typeof applied?.temperature === 'number' ? applied.temperature : 0.2,
  systemAppend: String(applied?.systemAppend || ''),
  targetWords: Number(applied?.targetWords || 0),
});
;(LLMDrafterPlanner as any).summarizeApplied = (cfg?: any) => {
  const n = Number(cfg?.targetWords || 0);
  const hasAppend = !!String(cfg?.systemAppend || '').trim();
  const parts: string[] = [];
  parts.push(n > 0 ? `Target Word Count: ~${n}` : 'Target Word Count: none');
  parts.push(`System prompt: ${hasAppend ? 'customized' : 'default'}`);
  return parts.join(' • ');
};
