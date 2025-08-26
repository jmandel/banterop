import { create } from 'zustand';
import type { PlannerConfigStore } from '../../planner/config/store';
import type { ConfigSnapshot, FieldState } from '../../planner/config/types';
import { validateScenarioConfig } from '../../../shared/scenario-validator';

async function fetchJson(url: string) {
  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
  // Limit payload size defensively by streaming text then JSON.parse
  const text = await res.text();
  try { return JSON.parse(text); }
  catch { throw new Error('Invalid JSON'); }
}

async function listModels(llm: any): Promise<string[]> {
  try {
    const xs = await llm?.listModels?.();
    if (Array.isArray(xs) && xs.length) return xs.map(String);
  } catch {}
  return ['openai/gpt-oss-120b:nitro'];
}

export function createScenarioConfigStore(opts: { llm: any; initial?: any }): PlannerConfigStore {
  type S = PlannerConfigStore & { _timer?: any; _lastUrl?: string; _scenario?: any; _mounted: boolean };
  const store = create<S>((set, get) => {
    const fields: FieldState[] = [
      { key: 'scenarioUrl', type: 'text', label: 'Scenario JSON URL', value: String(opts.initial?.resolvedScenario?.__sourceUrl || ''), placeholder: 'URL…', required: true },
      { key: 'model', type: 'select', label: 'Model', value: String(opts.initial?.model || ''), options: [], pending: true },
      { key: 'myAgentId', type: 'select', label: 'My role (agent)', value: String(opts.initial?.myAgentId || ''), options: [], visible: false, pending: true },
      { key: 'enabledTools', type: 'checkbox-group', label: 'Tools to enable', value: [], options: [], visible: false },
    ];

    const snap: ConfigSnapshot = {
      fields,
      canSave: !!opts.initial?.resolvedScenario,
      pending: true,
      dirty: false,
      summary: '',
      preview: undefined,
    };

    // Prime model list
    (async () => {
      const models = await listModels(opts.llm);
      if (!(get() as any)._mounted) return;
      const f = get().snap.fields.find(x => x.key === 'model')!;
      f.options = models.map(m => ({ value: m, label: m }));
      if (!f.value) f.value = models[0];
      f.pending = false;
      const anyPending = get().snap.fields.some(x => x.pending);
      const anyError = get().snap.fields.some(x => x.error);
      set(s => ({ snap: { ...s.snap, fields: [...s.snap.fields], pending: anyPending, dirty: true, canSave: !!(get() as any)._scenario && !anyPending && !anyError } }));
    })();

    function deriveFromScenario(scen: any) {
      const agents: any[] = Array.isArray(scen?.agents) ? scen.agents : [];
      const agentField = get().snap.fields.find(x => x.key === 'myAgentId')!;
      agentField.visible = agents.length > 0;
      agentField.options = agents.map((a: any) => ({
        value: String(a?.agentId || ''),
        label: [String(a?.agentId || ''), a?.principal?.name ? `— ${a.principal.name}` : ''].filter(Boolean).join(' ')
      }));
      if (!agentField.value || !agentField.options.some(o => o.value === agentField.value)) {
        agentField.value = agentField.options[0]?.value || '';
      }
      agentField.pending = false;

      // Tools for the selected agent
      function toolLabel(t: any): string {
        const name = String(t?.toolName || '');
        const desc = String(t?.description || '').trim();
        const short = desc.length > 60 ? (desc.slice(0, 57) + '…') : desc;
        const badge = t?.endsConversation ? ' • 🏁 ends' : '';
        return [name, short ? `— ${short}` : '', badge].filter(Boolean).join(' ');
      }
      const selectedAgentId = String(agentField.value || '');
      const selectedAgent = agents.find(a => a?.agentId === selectedAgentId) || agents[0];
      const tools = Array.isArray(selectedAgent?.tools) ? selectedAgent.tools : [];
      const toolNames = tools.map((t:any)=>String(t?.toolName||'')).filter(Boolean);
      const toolsField = get().snap.fields.find(x => x.key === 'enabledTools')!;
      toolsField.visible = tools.length > 0;
      toolsField.options = tools.map((t:any) => ({ value: String(t?.toolName || ''), label: toolLabel(t) }));
      toolsField.value = toolNames;

      const title = String(scen?.metadata?.title || scen?.metadata?.id || '');
      const agentsSummary = (scen?.agents ?? []).map((a: any) => a?.agentId).filter(Boolean).join(' ↔ ');
      set(s => ({ snap: { ...s.snap, preview: { title, agents: agentsSummary, toolCount: toolNames.length } } }));
    }

    async function validateUrl(url: string) {
      const me = (get()._lastUrl = url);
      const urlField = get().snap.fields.find(x => x.key === 'scenarioUrl')!;
      urlField.pending = true; urlField.error = null;
      set(s => ({ snap: { ...s.snap, fields: [...s.snap.fields], pending: true } }));

      try {
        const data = await fetchJson(url);
        if (get()._lastUrl !== me) return; // race
        // Try top-level first
        let chosen: any = null;
        let valTop = validateScenarioConfig(data);
        if (valTop.ok) {
          chosen = valTop.value;
        } else if (data && typeof data === 'object' && (data as any).config) {
          const valNested = validateScenarioConfig((data as any).config);
          if (valNested.ok) {
            chosen = valNested.value;
          } else {
            // keep top-level error messages
            urlField.error = valTop.errors.join('\n').slice(0, 1000);
            (get() as any)._scenario = null as any;
          }
        } else {
          urlField.error = valTop.errors.join('\n').slice(0, 1000);
          (get() as any)._scenario = null as any;
        }
        if (chosen) {
          (chosen as any).__sourceUrl = url;
          (get() as any)._scenario = chosen;
          deriveFromScenario(chosen);
          urlField.error = null;
        }
      } catch (e: any) {
        if (get()._lastUrl !== me) return;
        urlField.error = String(e?.message || 'Fetch failed');
        (get() as any)._scenario = null as any;
      } finally {
        if (!(get() as any)._mounted) return;
        urlField.pending = false;
        const anyPending = get().snap.fields.some(x => x.pending);
        const scenOk = !!(get() as any)._scenario;
        const anyError = get().snap.fields.some(x => x.error);
        set(s => ({ snap: { ...s.snap, fields: [...s.snap.fields], pending: anyPending, dirty: true, canSave: scenOk && !anyPending && !anyError } }));
      }
    }

    function setField(key: string, value: unknown) {
      const f = get().snap.fields.find(x => x.key === key)!;
      f.value = value;
      if (key === 'scenarioUrl') {
        const url = String(value || '').trim();
        const err = !url ? 'Enter a URL' : null;
        f.error = err; (get() as any)._scenario = null as any;
        const tools = get().snap.fields.find(x => x.key === 'enabledTools')!;
        tools.visible = false; tools.options = []; tools.value = [];
        const agentField = get().snap.fields.find(x => x.key === 'myAgentId')!;
        agentField.visible = false; agentField.options = []; agentField.value = '';
        agentField.pending = true;
        if ((get() as any)._timer) clearTimeout((get() as any)._timer);
        if (!err && url) (get() as any)._timer = setTimeout(() => validateUrl(url), 350);
      } else if (key === 'myAgentId') {
        // Re-derive tool list for selected agent
        const scen = (get() as any)._scenario;
        if (scen) {
          const agents: any[] = Array.isArray(scen?.agents) ? scen.agents : [];
          const selectedAgentId = String(value || '');
          const selectedAgent = agents.find(a => a?.agentId === selectedAgentId) || agents[0];
          const tools = Array.isArray(selectedAgent?.tools) ? selectedAgent.tools : [];
          const toolsField = get().snap.fields.find(x => x.key === 'enabledTools')!;
          const toolNames = tools.map((t:any)=>String(t?.toolName||'')).filter(Boolean);
          const toolLabel = (t:any) => {
            const name = String(t?.toolName || '');
            const desc = String(t?.description || '').trim();
            const short = desc.length > 60 ? (desc.slice(0,57)+'…') : desc;
            const badge = t?.endsConversation ? ' • 🏁 ends' : '';
            return [name, short ? `— ${short}` : '', badge].filter(Boolean).join(' ');
          };
          toolsField.visible = tools.length > 0;
          toolsField.options = tools.map((t:any)=>({ value: String(t?.toolName||''), label: toolLabel(t) }));
          toolsField.value = toolNames;
        }
      }
      const anyPending = get().snap.fields.some(x => x.pending);
      const anyError = get().snap.fields.some(x => x.error);
      const scenOk = !!(get() as any)._scenario;
      set(s => ({ snap: { ...s.snap, fields: [...s.snap.fields], pending: anyPending, dirty: true, canSave: scenOk && !anyPending && !anyError } }));
    }

    function exportApplied() {
      const urlField = get().snap.fields.find(x => x.key === 'scenarioUrl')!;
      if (urlField.pending) throw new Error('Validation in progress');
      if (urlField.error) throw new Error(urlField.error);
      if (!(get() as any)._scenario) throw new Error('Scenario not loaded/valid');

      const val = (k: string) => get().snap.fields.find(x => x.key === k)!.value;
      const applied = {
        resolvedScenario: (get() as any)._scenario,
        model: String(val('model') || ''),
        myAgentId: String(val('myAgentId') || ''),
        enabledTools: (val('enabledTools') as string[]) || [],
      };
      return { applied, ready: true };
    }

    function destroy() { (get() as any)._mounted = false; try { if ((get() as any)._timer) clearTimeout((get() as any)._timer); } catch {} }

    if (opts.initial?.resolvedScenario) {
      (get() as any)._scenario = opts.initial.resolvedScenario;
      deriveFromScenario(opts.initial.resolvedScenario);
    }

    return { snap, setField, exportApplied, destroy, _mounted: true } as any as S;
  });

  // Facade
  return {
    get snap() { return store.getState().snap; },
    setField: (k, v) => store.getState().setField(k, v),
    exportApplied: () => store.getState().exportApplied(),
    destroy: () => { try { store.getState().destroy(); } catch {} try { (store as any).destroy?.(); } catch {} },
    subscribe: (listener: () => void) => (store as any).subscribe(listener),
  };
}

// Attach companions onto the existing planner object
import { ScenarioPlannerV03 } from './scenario-planner';
export interface ScenarioPlannerApplied {
  resolvedScenario: any;
  model?: string;
  myAgentId?: string;
  enabledTools?: string[];
}

;(ScenarioPlannerV03 as any).createConfigStore = createScenarioConfigStore;
;(ScenarioPlannerV03 as any).toHarnessCfg = (applied: ScenarioPlannerApplied) => ({
  scenario: applied?.resolvedScenario,
  model: String(applied?.model || ''),
  myAgentId: String(applied?.myAgentId || ''),
  enabledTools: Array.isArray(applied?.enabledTools) ? applied.enabledTools : undefined,
});
;(ScenarioPlannerV03 as any).summarizeApplied = (applied: ScenarioPlannerApplied) => {
  const title = applied?.resolvedScenario?.metadata?.title || applied?.resolvedScenario?.metadata?.id || '';
  const model = applied?.model ? `Model: ${applied.model}` : '';
  const role = applied?.myAgentId ? `Role: ${applied.myAgentId}` : '';
  return [title, role, model].filter(Boolean).join(' • ');
};
