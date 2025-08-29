import React from 'react';
import { useAppStore } from '../../state/store';
import type { ScenarioConfiguration } from '../../../types/scenario-configuration.types';
import { validateScenarioConfig } from '../../../shared/scenario-validator';

const CORE_TOOLS = ['sendMessageToRemoteAgent', 'sendMessageToMyPrincipal', 'readAttachment', 'sleep', 'done'] as const;

export type ScenarioDraft = {
  scenario?: ScenarioConfiguration;
  scenarioUrl?: string;
  myAgentId?: string;
  enabledTools: string[];
  enabledCoreTools: string[];
  maxInlineSteps: number;
  instructions?: string; // Global additional instructions for planner prompting
};

const SCENARIO_DEFAULT_DRAFT: ScenarioDraft = {
  enabledTools: [],
  enabledCoreTools: [...CORE_TOOLS],
  maxInlineSteps: 20,
};

export function dehydrateScenario(full: ScenarioDraft) {
  const scenarioUrl = full.scenarioUrl || '';
  const myAgentId = String(full?.myAgentId || '');
  const toolsUniverse: string[] = (full?.scenario?.agents || [])
    .find((a: any) => a.agentId === myAgentId)?.tools?.map((t: any) => String(t.toolName || '')) || [];
  const disabledScenarioTools = toolsUniverse.filter(t => !(full.enabledTools || []).includes(t));
  const disabledCoreTools = CORE_TOOLS.filter(t => !(full.enabledCoreTools || []).includes(t));
  const seed: any = { v: 2, scenarioUrl };
  if (myAgentId) seed.myAgentId = myAgentId;
  if (Number.isFinite(full.maxInlineSteps)) seed.maxInlineSteps = Number(full.maxInlineSteps);
  if (disabledScenarioTools.length) seed.disabledScenarioTools = disabledScenarioTools;
  if (disabledCoreTools.length) seed.disabledCoreTools = disabledCoreTools;
  if (typeof full.instructions === 'string' && full.instructions.trim()) seed.instructions = full.instructions.trim();
  return seed;
}

export async function hydrateScenario(seed: any, ctx: { fetchJson: (u: string) => Promise<any>; cache: Map<string, any> }): Promise<{ config: ScenarioDraft; ready: boolean }> {
  const sUrl = String(seed?.scenarioUrl || '');
  if (!sUrl) throw new Error('Missing scenarioUrl');
  const key = `scen:${sUrl}`;
  let scen: ScenarioConfiguration | undefined = ctx.cache.get(key);
  if (!scen) {
    const raw = await ctx.fetchJson(sUrl);
    const val = validateScenarioConfig(raw);
    if (!val.ok) throw new Error(val.errors.join('\n').slice(0, 1000));
    scen = val.value;
    ctx.cache.set(key, scen);
  }
  const agents = Array.isArray(scen.agents) ? scen.agents : [];
  const requested = String(seed?.myAgentId || '');
  const myAgentId = agents.some(a => String(a.agentId || '') === requested) ? requested : (agents[0]?.agentId || '');
  const me = agents.find(a => a.agentId === myAgentId) || agents[0];
  const toolUniverse = (me?.tools || []).map((t: any) => String(t.toolName || ''));
  const disabledScenario = new Set<string>(Array.isArray(seed?.disabledScenarioTools) ? seed!.disabledScenarioTools.map(String) : []);
  const enabledTools = toolUniverse.filter(t => !disabledScenario.has(t));
  const disabledCore = new Set<string>(Array.isArray(seed?.disabledCoreTools) ? seed!.disabledCoreTools.map(String) : []);
  const enabledCoreTools = CORE_TOOLS.filter(t => !disabledCore.has(t));
  const maxInlineSteps = (() => {
    const n = Number(seed?.maxInlineSteps ?? 20);
    return Number.isFinite(n) ? Math.max(1, Math.min(50, Math.floor(n))) : 20;
  })();
  const instructions = typeof seed?.instructions === 'string' ? seed.instructions : undefined;
  return { config: { scenario: scen, scenarioUrl: sUrl, myAgentId, enabledTools, enabledCoreTools, maxInlineSteps, instructions } as any, ready: true };
}

export function ScenarioPlannerSetup() {
  const pid = 'scenario-v0.3';
  const row = useAppStore(s => s.plannerSetup.byPlanner[pid]);
  const draft: ScenarioDraft = (row?.draft as ScenarioDraft) || SCENARIO_DEFAULT_DRAFT;

  const [scenarioUrlInput, setScenarioUrlInput] = React.useState<string>(draft.scenarioUrl || '');
  const loadScenario = useAppStore(s => s.loadScenario);
  const setDraft = useAppStore(s => s.setSetupDraft);
  const setMeta = useAppStore(s => s.setSetupMeta);

  const scen = draft.scenario;
  const agents = Array.isArray(scen?.agents) ? scen!.agents : [];
  const agentOpts = agents.map(a => ({ value: String(a.agentId || ''), label: [a.agentId, a?.principal?.name ? ` — ${a.principal.name}` : ''].filter(Boolean).join('') }));
  const myAgentId = agentOpts.some(o => o.value === (draft.myAgentId || '')) ? (draft.myAgentId as string) : (agentOpts[0]?.value || '');
  const me = agents.find(a => a.agentId === myAgentId) || agents[0];
  const tools = (me?.tools || []);
  const toolOpts = tools.map((t: any) => ({ value: String(t.toolName || ''), label: toolLabel(t) }));

  function update(next: Partial<ScenarioDraft>) {
    const full = { ...draft, ...next } as ScenarioDraft;
    const valid = !!full.scenario && !!full.myAgentId && Number.isFinite(Number(full.maxInlineSteps)) && Number(full.maxInlineSteps) >= 1 && Number(full.maxInlineSteps) <= 50;
    setDraft(pid, full);
    setMeta(pid, {
      valid,
      summary: full.scenarioUrl ? `Scenario: ${full.scenarioUrl}` : 'Scenario: (none)',
      seed: valid ? dehydrateScenario(full) : undefined,
      errors: undefined
    });
  }

  async function tryLoadScenario(url: string) {
    const u = String(url || '').trim();
    if (!u) { update({ scenario: undefined, scenarioUrl: '' }); return; }
    setMeta(pid, { pending: true, errors: undefined });
    try {
      const scen = await loadScenario(u);
      // Preserve prior selections when valid
      const agents = Array.isArray(scen.agents) ? scen.agents : [];
      const priorAgent = String(draft.myAgentId || '');
      const agentId = agents.some((a:any)=>String(a.agentId||'')===priorAgent) ? priorAgent : (agents[0]?.agentId || '');
      const toolUniverse = (agents.find((a:any) => a.agentId === agentId)?.tools || []).map((t:any)=>String(t.toolName||''));
      const priorTools = Array.isArray(draft.enabledTools) ? draft.enabledTools.map(String) : [];
      const enabledTools = (agentId === priorAgent)
        ? priorTools.filter(t => toolUniverse.includes(t))
        : toolUniverse;
      update({ scenario: scen, scenarioUrl: u, myAgentId: agentId, enabledTools });
    } catch (e:any) {
      setMeta(pid, { errors: { scenarioUrl: String(e?.message || 'Failed to load scenario') } });
    } finally {
      setMeta(pid, { pending: false });
    }
  }

  // Debounce-load on URL changes to validate while typing
  React.useEffect(() => {
    const u = String(scenarioUrlInput || '').trim();
    let canceled = false;
    const handle = setTimeout(() => { if (!canceled) void tryLoadScenario(u); }, 500);
    return () => { canceled = true; clearTimeout(handle); };
  }, [scenarioUrlInput, loadScenario]);

  function toggleList(sel: string[], v: string) {
    const s = new Set<string>(sel);
    if (s.has(v)) s.delete(v); else s.add(v);
    return Array.from(s);
  }

  return (
    <div style={{display:'grid', gap:10, maxWidth:680}}>
      <label className="small">Scenario JSON URL</label>
      <input className="input" value={scenarioUrlInput} placeholder="URL…"
        onChange={e => setScenarioUrlInput(e.target.value)} />
      {row?.errors?.scenarioUrl && <div className="small" style={{ color:'#c62828' }}>{row.errors.scenarioUrl}</div>}

      <label className="small">My role (agent)</label>
      <select className="input" value={myAgentId}
        onChange={e => {
          const nextId = e.target.value;
          const allToolNames = (agents.find(a=>a.agentId===nextId)?.tools || []).map((t:any)=>String(t.toolName||''));
          update({ myAgentId: nextId, enabledTools: allToolNames });
        }} disabled={!agents.length}>
        {agentOpts.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>

      {!!toolOpts.length && (
        <div>
          <label className="small" style={{ fontWeight: 600 }}>Scenario tools</label>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: 8 }}>
            {toolOpts.map(o => (
              <label key={o.value} className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <input type="checkbox" checked={draft.enabledTools.includes(o.value)} onChange={() => update({ enabledTools: toggleList(draft.enabledTools, o.value) })} /> {o.label}
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="small" style={{ fontWeight: 600 }}>Core tools</label>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px,1fr))', gap: 8 }}>
      {CORE_TOOLS.map(t => (
        <label key={t} className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input type="checkbox" checked={draft.enabledCoreTools.includes(t)} onChange={() => update({ enabledCoreTools: toggleList(draft.enabledCoreTools, t) })} /> {t}
        </label>
      ))}
      </div>
    </div>

      {/* Additional Instructions (global) */}
      <label className="small" style={{ fontWeight: 600 }}>Additional Instructions</label>
      <textarea
        className="input"
        rows={3}
        placeholder="Optional global guidance appended to the planner's system prompt"
        value={draft.instructions || ''}
        onChange={e => update({ instructions: e.target.value })}
      />

      <label className="small">Max inline steps</label>
      <input className="input" value={String(draft.maxInlineSteps)} onChange={e => {
        const n = Math.max(1, Math.min(50, Math.floor(Number(e.target.value||'20'))));
        update({ maxInlineSteps: Number.isFinite(n) ? n : 20 });
      }} />
      <div className="small muted">Range: 1–50</div>
    </div>
  );
}

function toolLabel(t: { toolName?: string; description?: string; endsConversation?: boolean }): string {
  const name = String(t?.toolName || '');
  const desc = String(t?.description || '').trim();
  const short = desc.length > 60 ? (desc.slice(0, 57) + '…') : desc;
  const badge = t?.endsConversation ? ' • 🏁 ends' : '';
  return [name, short ? `— ${short}` : '', badge].filter(Boolean).join(' ');
}
