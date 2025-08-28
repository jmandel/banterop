import { create } from 'zustand';
import type { PlannerConfigStore, FieldState, ConfigSnapshot } from '../config/types';
import { createFieldState, updateField } from '../config/types';

// Scenario-specific field definitions
function createScenarioFields(): FieldState[] {
  return [
    createFieldState({
      key: 'scenarioUrl',
      type: 'text',
      label: 'Scenario JSON URL',
      placeholder: 'https://...',
      required: true,
    }),
    createFieldState({
      key: 'model',
      type: 'select',
      label: 'Model',
      options: [],
      visible: false,
    }),
    createFieldState({
      key: 'myAgentId',
      type: 'select',
      label: 'My role (agent)',
      options: [],
      visible: false,
    }),
    createFieldState({
      key: 'enabledTools',
      type: 'checkbox-group',
      label: 'Scenario tools',
      options: [],
      visible: false,
    }),
    createFieldState({
      key: 'maxInlineSteps',
      type: 'text',
      label: 'Max inline steps',
      defaultValue: '20',
      placeholder: '1–50',
    }),
  ];
}

// Scenario config store state
type ScenarioConfigState = {
  fields: FieldState[];
  scenario: any;
  loading: Set<string>;
  initialized: boolean;
};

// Scenario config store actions
type ScenarioConfigActions = {
  initialize: (values: Record<string, unknown>) => Promise<void>;
  setScenarioUrl: (url: string) => Promise<void>;
  setMyAgentId: (agentId: string) => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setEnabledTools: (tools: string[]) => Promise<void>;
  setMaxInlineSteps: (steps: number) => Promise<void>;
  updateDependentFields: () => Promise<void>;
  updateToolOptions: () => Promise<void>;
  setField: (key: string, value: unknown) => Promise<void>;
  exportConfig: () => { config: any; ready: boolean };
};

export function createScenarioConfigStore(opts: {
  llm: any;
  initialValues?: Record<string, unknown>;
  onConfigChange?: (config: any) => void;
}): PlannerConfigStore {
  const store = create<ScenarioConfigState & ScenarioConfigActions>((set, get) => ({
    // Initial state
    fields: createScenarioFields(),
    scenario: null,
    loading: new Set(),
    initialized: false,

    // Initialize from saved values or URL
    initialize: async (values) => {
      // Step 1: Set scenario URL and fetch scenario
      if (values.scenarioUrl) {
        await get().setScenarioUrl(String(values.scenarioUrl));
      }

      // Step 2: Set agent selection (triggers tool loading)
      if (values.myAgentId) {
        await get().setMyAgentId(String(values.myAgentId));
      }

      // Step 3: Set other independent fields
      if (values.model) await get().setModel(String(values.model));
      if (values.enabledTools) await get().setEnabledTools(values.enabledTools as string[]);
      if (values.maxInlineSteps) await get().setMaxInlineSteps(Number(values.maxInlineSteps));

      set({ initialized: true });
    },

    // Field-specific setters with planner logic
    setScenarioUrl: async (url) => {
      set(s => ({
        fields: updateField(s.fields, 'scenarioUrl', url),
        loading: new Set([...s.loading, 'scenarioUrl'])
      }));

      try {
        const scenario = await fetchScenarioJson(url);
        set({
          scenario,
          loading: new Set([...get().loading].filter(k => k !== 'scenarioUrl'))
        });

        // Trigger dependent updates
        await get().updateDependentFields();

        // Notify parent of config change
        opts.onConfigChange?.(get().exportConfig().config);
      } catch (error) {
        set(s => ({
          loading: new Set([...s.loading].filter(k => k !== 'scenarioUrl')),
          fields: updateField(s.fields, 'scenarioUrl', url, 'Failed to fetch scenario')
        }));
      }
    },

    setMyAgentId: async (agentId) => {
      set(s => ({ fields: updateField(s.fields, 'myAgentId', agentId) }));
      await get().updateToolOptions();
      opts.onConfigChange?.(get().exportConfig().config);
    },

    setModel: async (model) => {
      set(s => ({ fields: updateField(s.fields, 'model', model) }));
      opts.onConfigChange?.(get().exportConfig().config);
    },

    setEnabledTools: async (tools) => {
      set(s => ({ fields: updateField(s.fields, 'enabledTools', tools) }));
      opts.onConfigChange?.(get().exportConfig().config);
    },

    setMaxInlineSteps: async (steps) => {
      const num = Math.max(1, Math.min(50, Number(steps) || 20));
      set(s => ({ fields: updateField(s.fields, 'maxInlineSteps', num) }));
      opts.onConfigChange?.(get().exportConfig().config);
    },

    // Generic field setter for UI
    setField: async (key, value) => {
      switch (key) {
        case 'scenarioUrl': return get().setScenarioUrl(String(value));
        case 'myAgentId': return get().setMyAgentId(String(value));
        case 'model': return get().setModel(String(value));
        case 'enabledTools': return get().setEnabledTools(value as string[]);
        case 'maxInlineSteps': return get().setMaxInlineSteps(Number(value));
      }
    },

    // Update dependent fields after scenario changes
    updateDependentFields: async () => {
      const { scenario } = get();
      if (!scenario) return;

      // Update model options
      const models = await getAvailableModels(opts.llm);
      set(s => ({
        fields: s.fields.map(f =>
          f.key === 'model'
            ? { ...f, options: models.map(m => ({ value: m, label: m })), visible: true }
            : f
        )
      }));

      // Update agent options
      const agents = scenario.agents || [];
      const agentOptions = agents.map((a: any) => ({
        value: a.agentId,
        label: `${a.agentId} — ${a.principal?.name || ''}`
      }));
      set(s => ({
        fields: s.fields.map(f =>
          f.key === 'myAgentId'
            ? { ...f, options: agentOptions, visible: agents.length > 0 }
            : f
        )
      }));
    },

    // Update tool options based on selected agent
    updateToolOptions: async () => {
      const { scenario, fields } = get();
      const selectedAgentId = fields.find(f => f.key === 'myAgentId')?.value;

      if (!scenario || !selectedAgentId) return;

      const agent = scenario.agents.find((a: any) => a.agentId === selectedAgentId);
      const tools = agent?.tools || [];

      const toolOptions = tools.map((t: any) => ({
        value: t.toolName,
        label: `${t.toolName} — ${t.description || ''}`
      }));

      set(s => ({
        fields: s.fields.map(f =>
          f.key === 'enabledTools'
            ? { ...f, options: toolOptions, visible: tools.length > 0 }
            : f
        )
      }));
    },

    // Export current config
    exportConfig: () => {
      const { fields, scenario } = get();
      const values = Object.fromEntries(
        fields.map(f => [f.key, f.value])
      );

      return {
        config: {
          scenario,
          model: values.model,
          myAgentId: values.myAgentId,
          enabledTools: values.enabledTools || [],
          maxInlineSteps: Number(values.maxInlineSteps) || 20
        },
        ready: !!(scenario && values.model && values.myAgentId)
      };
    }
  }));

  // Auto-initialize if we have initial values
  if (opts.initialValues) {
    store.getState().initialize(opts.initialValues);
  }

  // Return the store facade expected by the UI
  return {
    get snap() {
      const { fields, scenario, loading } = store.getState();
      const anyPending = fields.some(f => f.pending) || loading.size > 0;
      const anyError = fields.some(f => f.error);
      const { config, ready } = store.getState().exportConfig();

      return {
        fields,
        canSave: ready && !anyPending && !anyError,
        pending: anyPending,
        dirty: true, // For now, assume dirty if not saved
        summary: scenario ? `${scenario.metadata?.title || 'Scenario'} • ${config.myAgentId}` : '',
        preview: scenario ? {
          title: scenario.metadata?.title || '',
          agents: scenario.agents?.length || 0,
          tools: config.enabledTools?.length || 0
        } : undefined
      };
    },

    setField: (key, value) => store.getState().setField(key, value),
    exportConfig: () => store.getState().exportConfig(),
    destroy: () => {
      // Zustand stores don't need explicit destruction
      // but we can clean up subscriptions if needed
    },

    subscribe: (listener) => store.subscribe(listener)
  };
}

// Helper functions
async function fetchScenarioJson(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error('Failed to fetch scenario');
  return await response.json();
}

async function getAvailableModels(llm: any): Promise<string[]> {
  try {
    const models = await llm?.listModels?.();
    return Array.isArray(models) ? models : ['openai/gpt-4', 'openai/gpt-3.5-turbo'];
  } catch {
    return ['openai/gpt-4', 'openai/gpt-3.5-turbo'];
  }
}
