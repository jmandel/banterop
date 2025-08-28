import type { PlannerFieldsVM, Field, ReduceResult, Patch } from '../../setup-vm/types';
import { fetchJsonCapped } from '../../../shared/net';
import { validateScenarioConfig } from '../../../shared/scenario-validator';
import type { ScenarioConfiguration } from '../../../types/scenario-configuration.types';
import { ScenarioPlannerV03 } from './scenario-planner';

// Constants
const CURATED_MODELS = ['openai/gpt-oss-120b:nitro', 'qwen/qwen3-235b-a22b-2507:nitro'];
const CORE_TOOLS = ['sendMessageToRemoteAgent', 'sendMessageToMyPrincipal', 'readAttachment', 'sleep', 'done'];

export type ScenarioSeedV2 = {
  v: 2;
  scenarioUrl: string;
  model?: string;
  myAgentId?: string;
  maxInlineSteps?: number;
  disabledScenarioTools?: string[];
  disabledCoreTools?: string[];
};

export type FullConfig = {
  scenario: ScenarioConfiguration;
  model: string;
  myAgentId: string;
  enabledTools: string[];
  enabledCoreTools: string[];
  maxInlineSteps: number;
};

// Helper functions
function findField(fs: Field[], key: string): Field | undefined {
  return fs.find(f => f.key === key);
}

function options(list: string[]): Array<{ value: string; label: string }> {
  return list.map(v => ({ value: v, label: v }));
}

function toolLabel(t: { toolName?: string; description?: string; endsConversation?: boolean }): string {
  const name = String(t?.toolName || '');
  const desc = String(t?.description || '').trim();
  const short = desc.length > 60 ? (desc.slice(0, 57) + '…') : desc;
  const badge = t?.endsConversation ? ' • 🏁 ends' : '';
  return [name, short ? `— ${short}` : '', badge].filter(Boolean).join(' ');
}

function normalizeTools(sel: string[], all: string[], defaultAllIfEmpty: boolean): string[] {
  const want = new Set((sel || []).map(String));
  const filtered = all.filter(x => want.has(x));
  if (filtered.length) return filtered;
  return defaultAllIfEmpty ? all : [];
}

// VM Implementation
export function createScenarioSetupVM(): PlannerFieldsVM<ScenarioSeedV2, FullConfig> {
  return {
    id: 'scenario-v0.3',

    baseFields(): Field[] {
      return [
        { key: 'scenarioUrl', type: 'text', label: 'Scenario JSON URL', value: '', placeholder: 'URL…' },
        { key: 'model', type: 'select', label: 'Model', value: CURATED_MODELS[0], options: options(CURATED_MODELS) },
        { key: 'myAgentId', type: 'select', label: 'My role (agent)', value: '', options: [], visible: false, disabled: true },
        { key: 'enabledTools', type: 'checkbox-group', label: 'Scenario tools', value: [], options: [], visible: false },
        { key: 'enabledCoreTools', type: 'checkbox-group', label: 'Core tools', value: [...CORE_TOOLS], options: CORE_TOOLS.map(v => ({ value: v, label: v })) },
        { key: 'maxInlineSteps', type: 'text', label: 'Max inline steps', value: '20', placeholder: '1–50' },
      ];
    },

    reduce(current, ev): ReduceResult {
      const patches: Patch[] = [];

      const readUrl = () => String((findField(current, 'scenarioUrl') as any)?.value || '').trim();
      const tokenFor = (url: string) => `load:scenario@${url}`;

      if (ev.type === 'BOOT') {
        return { patches };
      }

      if (ev.type === 'FIELD_CHANGE') {
        const { key, value } = ev;
        patches.push({ op: 'setFieldValue', key, value });

        if (key === 'scenarioUrl') {
          // Reset dependent fields, mark disabled, clear errors
          patches.push(
            { op: 'setFieldError', key: 'scenarioUrl', error: null },
            { op: 'setFieldDisabled', key: 'myAgentId', disabled: true },
            { op: 'setFieldVisible', key: 'myAgentId', visible: false },
            { op: 'setFieldOptions', key: 'myAgentId', options: [] },
            { op: 'setFieldVisible', key: 'enabledTools', visible: false },
            { op: 'setFieldOptions', key: 'enabledTools', options: [] },
            { op: 'setFieldValue', key: 'enabledTools', value: [] },
            { op: 'setFieldMeta', key: 'scenarioUrl', meta: undefined }
          );

          const url = String(value || '').trim();
          if (url) {
            const token = tokenFor(url);
            return {
              patches,
              effects: [{
                token,
                run: async (ctx) => {
                  const key = `scen:${url}`;
                  if (ctx.cache.has(key)) return ctx.cache.get(key);
                  const raw = await fetchJsonCapped(url);
                  ctx.cache.set(key, raw);
                  return raw;
                }
              }]
            };
          }
          return { patches };
        }

        if (key === 'myAgentId') {
          // Recompute tools from cached scenario in meta
          const fUrl = findField(current, 'scenarioUrl');
          const scen: ScenarioConfiguration | undefined = fUrl?.meta?.scenario;
          if (scen) {
            const me = (scen.agents || []).find(a => a.agentId === String(value)) || scen.agents?.[0];
            const tools = (me?.tools || []);
            const toolOptions = tools.map((t: any) => ({ value: String(t.toolName || ''), label: toolLabel(t) }));
            const allToolNames = toolOptions.map(o => o.value);
            const prevSel = (findField(current, 'enabledTools') as any)?.value || [];
            const nextSel = normalizeTools(prevSel, allToolNames, true);
            patches.push(
              { op: 'setFieldOptions', key: 'enabledTools', options: toolOptions },
              { op: 'setFieldValue', key: 'enabledTools', value: nextSel },
              { op: 'setFieldVisible', key: 'enabledTools', visible: tools.length > 0 }
            );
          }
          return { patches };
        }

        return { patches };
      }

      if (ev.type === 'ASYNC_RESULT') {
        const urlNow = readUrl();
        if (!ev.token.endsWith(urlNow)) {
          return { patches }; // Stale result
        }

        let chosen: ScenarioConfiguration | null = null;
        let err: string | null = null;
        try {
          const top = validateScenarioConfig(ev.data);
          if (top.ok) chosen = top.value;
          else if (ev.data && typeof ev.data === 'object' && (ev.data as any).config) {
            const nested = validateScenarioConfig((ev.data as any).config);
            chosen = nested.ok ? nested.value : null;
            if (!chosen) err = top.errors.join('\n').slice(0, 1000);
          } else err = top.errors.join('\n').slice(0, 1000);
        } catch (e: any) {
          err = String(e?.message || 'Invalid scenario');
        }

        if (!chosen) {
          patches.push({ op: 'setFieldError', key: 'scenarioUrl', error: err || 'Invalid scenario' });
          return { patches };
        }

        (chosen as any).__sourceUrl = urlNow;

        // Set up agents
        const agents = Array.isArray(chosen.agents) ? chosen.agents : [];
        const agentOpts = agents.map(a => ({
          value: String(a.agentId || ''),
          label: [a.agentId, a?.principal?.name ? ` — ${a.principal.name}` : ''].filter(Boolean).join('')
        }));
        const prevAgent = String((findField(current, 'myAgentId') as any)?.value || '');
        const myAgentId = agentOpts.some(o => o.value === prevAgent) ? prevAgent : (agentOpts[0]?.value || '');

        // Set up tools of selected agent
        const me = agents.find(a => a.agentId === myAgentId) || agents[0];
        const tools = (me?.tools || []);
        const toolOpts = tools.map((t: any) => ({ value: String(t.toolName || ''), label: toolLabel(t) }));
        const allToolNames = toolOpts.map(o => o.value);

        const prevTools = (findField(current, 'enabledTools') as any)?.value || [];
        const nextTools = normalizeTools(prevTools, allToolNames, true);

        patches.push(
          { op: 'setFieldMeta', key: 'scenarioUrl', meta: { scenario: chosen } },
          { op: 'setFieldError', key: 'scenarioUrl', error: null },
          { op: 'setFieldOptions', key: 'myAgentId', options: agentOpts },
          { op: 'setFieldValue', key: 'myAgentId', value: myAgentId },
          { op: 'setFieldVisible', key: 'myAgentId', visible: agents.length > 0 },
          { op: 'setFieldDisabled', key: 'myAgentId', disabled: false },
          { op: 'setFieldOptions', key: 'enabledTools', options: toolOpts },
          { op: 'setFieldValue', key: 'enabledTools', value: nextTools },
          { op: 'setFieldVisible', key: 'enabledTools', visible: tools.length > 0 }
        );
        return { patches };
      }

      if (ev.type === 'ASYNC_ERROR') {
        const urlNow = readUrl();
        if (ev.token.endsWith(urlNow)) {
          patches.push({ op: 'setFieldError', key: 'scenarioUrl', error: ev.error || 'Fetch failed' });
        }
        return { patches };
      }

      return { patches };
    },

    // Fast-forward from seed (for deep-linking)
    async fastForward(seed, ctx) {
      const sUrl = String(seed?.scenarioUrl || '');
      if (!sUrl) throw new Error('Missing scenarioUrl');

      console.log('[scenario/fastForward] Starting fast-forward for:', sUrl);
      console.log('[scenario/fastForward] Seed data:', seed);

      // Fetch scenario JSON (same validation logic as interactive ASYNC_RESULT)
      const key = `scen:${sUrl}`;
      let scen = ctx.cache.get(key);
      if (!scen) {
        console.log('[scenario/fastForward] Fetching scenario JSON from:', sUrl);
        const raw = await ctx.fetchJson(sUrl);
        console.log('[scenario/fastForward] Raw response:', raw);

        // Use same validation logic as ASYNC_RESULT handler
        let chosen: ScenarioConfiguration | null = null;
        let err: string | null = null;
        try {
          const top = validateScenarioConfig(raw);
          if (top.ok) chosen = top.value;
          else if (raw && typeof raw === 'object' && (raw as any).config) {
            // Handle nested config structure
            const nested = validateScenarioConfig((raw as any).config);
            chosen = nested.ok ? nested.value : null;
            if (!chosen) err = top.errors.join('\n').slice(0, 1000);
          } else err = top.errors.join('\n').slice(0, 1000);
        } catch (e: any) {
          err = String(e?.message || 'Invalid scenario');
        }

        if (!chosen) {
          console.error('[scenario/fastForward] Scenario validation failed:', err);
          console.error('[scenario/fastForward] Raw scenario data:', JSON.stringify(raw, null, 2));
          throw new Error(`Invalid scenario: ${err}`);
        }

        scen = { ...chosen, __sourceUrl: sUrl };
        ctx.cache.set(key, scen);
        console.log('[scenario/fastForward] Scenario loaded and validated successfully');
      } else {
        console.log('[scenario/fastForward] Using cached scenario');
      }

      // Extract all scenario data (same as ASYNC_RESULT in interactive flow)
      const agents = Array.isArray(scen.agents) ? scen.agents : [];
      const agentOpts = agents.map((a: { agentId?: string; principal?: { name?: string } }) => ({
        value: String(a.agentId || ''),
        label: [a.agentId, a?.principal?.name ? ` — ${a.principal.name}` : ''].filter(Boolean).join('')
      }));

      // Apply user's saved selections from seed
      const model = String(seed?.model || CURATED_MODELS[0]);
      const savedAgentId = String(seed?.myAgentId || '');
      const myAgentId = agentOpts.some(o => o.value === savedAgentId) ? savedAgentId : (agentOpts[0]?.value || '');

      // Get tools for selected agent
      const me = agents.find((a: any) => a.agentId === myAgentId) || agents[0];
      const tools = (me?.tools || []);
      const toolOpts = tools.map((t: { toolName?: string; description?: string; endsConversation?: boolean }) => ({
        value: String(t.toolName || ''),
        label: toolLabel(t)
      }));

      // Apply user's tool selections from seed
      const toolUniverse = toolOpts.map((o: { value: string; label: string }) => o.value);
      const disabledScenario = new Set<string>(Array.isArray(seed?.disabledScenarioTools) ? seed!.disabledScenarioTools.map(String) : []);
      const enabledTools = toolUniverse.filter((t: string) => !disabledScenario.has(t));

      // Apply core tool selections from seed
      const disabledCore = new Set<string>(Array.isArray(seed?.disabledCoreTools) ? seed!.disabledCoreTools.map(String) : []);
      const enabledCoreTools = CORE_TOOLS.filter(t => !disabledCore.has(t));

      // Apply max steps from seed
      const maxInlineSteps = (() => {
        const n = Number(seed?.maxInlineSteps ?? 20);
        return Number.isFinite(n) ? Math.max(1, Math.min(50, Math.floor(n))) : 20;
      })();

      console.log('[scenario/fastForward] Applied seed selections:', {
        model,
        myAgentId,
        enabledTools: enabledTools.length,
        enabledCoreTools: enabledCoreTools.length,
        maxInlineSteps
      });

      const fields: Field[] = [
        { key: 'scenarioUrl', type: 'text', label: 'Scenario JSON URL', value: sUrl, placeholder: 'URL…', meta: { scenario: scen } },
        { key: 'model', type: 'select', label: 'Model', value: model, options: options(CURATED_MODELS) },
        { key: 'myAgentId', type: 'select', label: 'My role (agent)', value: myAgentId, options: agentOpts, visible: agents.length > 0, disabled: false },
        { key: 'enabledTools', type: 'checkbox-group', label: 'Scenario tools', value: enabledTools, options: toolOpts, visible: tools.length > 0 },
        { key: 'enabledCoreTools', type: 'checkbox-group', label: 'Core tools', value: enabledCoreTools, options: CORE_TOOLS.map(v => ({ value: v, label: v })) },
        { key: 'maxInlineSteps', type: 'text', label: 'Max inline steps', value: String(maxInlineSteps), placeholder: '1–50' },
      ];

      const full: FullConfig = {
        scenario: scen,
        model,
        myAgentId,
        enabledTools,
        enabledCoreTools,
        maxInlineSteps
      };

      console.log('[scenario/fastForward] Complete - returning fully populated fields');
      return { fields, full };
    },

    // Validate fields to FullConfig
    validateToFull(fields) {
      const by = (k: string) => findField(fields, k);
      const scen = by('scenarioUrl')?.meta?.scenario as ScenarioConfiguration | undefined;
      if (!scen) return { ok: false, errors: [{ key: 'scenarioUrl', msg: 'Scenario not loaded' }] };

      const model = String((by('model') as any)?.value || CURATED_MODELS[0]);
      const myAgentId = String((by('myAgentId') as any)?.value || '');
      const me = (scen?.agents || []).find(a => a.agentId === myAgentId) || null;
      if (!me) return { ok: false, errors: [{ key: 'myAgentId', msg: 'Select an agent' }] };

      const toolUniverse = (me.tools || []).map((t: any) => String(t.toolName || '')).filter(Boolean);
      const selTools = Array.isArray((by('enabledTools') as any)?.value) ? (by('enabledTools') as any).value as string[] : [];
      const bad = selTools.filter(t => !toolUniverse.includes(t));
      if (bad.length) return { ok: false, errors: [{ key: 'enabledTools', msg: `Unknown tools: ${bad.join(', ')}` }] };

      const coreSel = Array.isArray((by('enabledCoreTools') as any)?.value) ? (by('enabledCoreTools') as any).value as string[] : [...CORE_TOOLS];
      const coreBad = coreSel.filter(t => !CORE_TOOLS.includes(t));
      if (coreBad.length) return { ok: false, errors: [{ key: 'enabledCoreTools', msg: `Unknown core tools: ${coreBad.join(', ')}` }] };

      const maxRaw = String((by('maxInlineSteps') as any)?.value || '20');
      const max = Math.max(1, Math.min(50, Math.floor(Number(maxRaw))));
      if (!Number.isFinite(max)) return { ok: false, errors: [{ key: 'maxInlineSteps', msg: 'Enter an integer 1–50' }] };

      const full: FullConfig = {
        scenario: scen,
        model,
        myAgentId,
        enabledTools: selTools,
        enabledCoreTools: coreSel.length ? coreSel : [...CORE_TOOLS],
        maxInlineSteps: max,
      };
      return { ok: true, full };
    },

    // Convert FullConfig to compact seed
    dehydrate(full) {
      const scenarioUrl = (full as any)?.scenario?.__sourceUrl || '';
      const myAgentId = String(full?.myAgentId || '');
      const toolsUniverse: string[] =
        ((full as any)?.scenario?.agents || []).find((a: any) => a.agentId === myAgentId)?.tools?.map((t: any) => String(t.toolName || '')) || [];
      const disabledScenarioTools = toolsUniverse.filter(t => !(full.enabledTools || []).includes(t));
      const disabledCoreTools = CORE_TOOLS.filter(t => !(full.enabledCoreTools || CORE_TOOLS).includes(t));

      const seed: ScenarioSeedV2 = { v: 2, scenarioUrl };
      if (full.model) (seed as any).model = String(full.model);
      if (myAgentId) (seed as any).myAgentId = myAgentId;
      if (Number.isFinite(full.maxInlineSteps)) (seed as any).maxInlineSteps = Number(full.maxInlineSteps);
      if (disabledScenarioTools.length) (seed as any).disabledScenarioTools = disabledScenarioTools;
      if (disabledCoreTools.length) (seed as any).disabledCoreTools = disabledCoreTools;
      return seed;
    },

    // Convert seed to FullConfig (for startUrlSync)
    async hydrate(seed, ctx) {
      const sUrl = String(seed?.scenarioUrl || '');
      if (!sUrl) throw new Error('Missing scenarioUrl');

      const key = `scen:${sUrl}`;
      let scen = ctx.cache.get(key);
      if (!scen) {
        const raw = await ctx.fetchJson(sUrl);
        const val = validateScenarioConfig(raw);
        if (!val.ok) throw new Error(val.errors.join('\n').slice(0, 1000));
        scen = { ...val.value, __sourceUrl: sUrl };
        ctx.cache.set(key, scen);
      }

      const model = String(seed?.model || CURATED_MODELS[0]);
      const agentIds = (scen?.agents || []).map((a: any) => String(a.agentId || ''));
      const myAgentId = agentIds.includes(String(seed?.myAgentId || '')) ? String(seed!.myAgentId) : (agentIds[0] || '');

      const me = (scen?.agents || []).find((a: any) => a.agentId === myAgentId) || scen?.agents?.[0];
          const tools = (me?.tools || []).map((t: { toolName?: string }) => String(t.toolName || '')).filter(Boolean);

      const disabledScenario = new Set<string>(Array.isArray(seed?.disabledScenarioTools) ? seed!.disabledScenarioTools.map(String) : []);
      const enabledTools = tools.filter(t => !disabledScenario.has(t));
      const disabledCore = new Set<string>(Array.isArray(seed?.disabledCoreTools) ? seed!.disabledCoreTools.map(String) : []);
      const enabledCoreTools = CORE_TOOLS.filter(t => !disabledCore.has(t));

      const maxInlineSteps = (() => {
        const n = Number(seed?.maxInlineSteps ?? 20);
        return Number.isFinite(n) ? Math.max(1, Math.min(50, Math.floor(n))) : 20;
      })();

      const full: FullConfig = { scenario: scen, model, myAgentId, enabledTools, enabledCoreTools, maxInlineSteps };
      return { full };
    }
  };
}

// Attach to ScenarioPlanner for registry use
;(ScenarioPlannerV03 as any).createSetupVM = createScenarioSetupVM;
;(ScenarioPlannerV03 as any).dehydrate = (full: FullConfig) => createScenarioSetupVM().dehydrate(full);
;(ScenarioPlannerV03 as any).hydrate = async (seed: ScenarioSeedV2, ctx: any) => createScenarioSetupVM().hydrate(seed, ctx);
