import { create } from 'zustand';
import type { PlannerConfigStore, FieldState, FieldOption } from '../config/types';

// Helper function to create initial field state
function createFieldState(definition: any): FieldState {
  return {
    key: definition.key,
    type: definition.type,
    label: definition.label,
    value: definition.defaultValue || '',
    placeholder: definition.placeholder,
    help: definition.help,
    required: definition.required,
    visible: definition.visible !== false,
    options: definition.options || [],
    error: null,
    pending: false,
  };
}

// Helper function to update field in array
function updateField(fields: FieldState[], key: string, value: unknown, error?: string | null): FieldState[] {
  return fields.map(f =>
    f.key === key
      ? { ...f, value, error: error !== undefined ? error : f.error, pending: false }
      : f
  );
}

// LLM Drafter-specific field definitions
function createLLMDrafterFields(): FieldState[] {
  return [
    createFieldState({
      key: 'model',
      type: 'select',
      label: 'Model',
      options: [],
      required: true,
    }),
    createFieldState({
      key: 'systemAppend',
      type: 'text',
      label: 'System prompt (append)',
      placeholder: 'Optional: appended to built-in system prompt',
    }),
    createFieldState({
      key: 'targetWords',
      type: 'text',
      label: 'Target word count',
      defaultValue: '0',
      placeholder: '0 to disable, or positive number',
      help: 'Aim near this length; set 0 to disable.',
    }),
  ];
}

// LLM Drafter config store state
type LLMDrafterConfigState = {
  fields: FieldState[];
  models: string[];
  initialized: boolean;
};

// LLM Drafter config store actions
type LLMDrafterConfigActions = {
  initialize: (values: Record<string, unknown>) => Promise<void>;
  loadModels: () => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setSystemAppend: (text: string) => Promise<void>;
  setTargetWords: (count: number) => Promise<void>;
  setField: (key: string, value: unknown) => Promise<void>;
  exportConfig: () => { config: any; ready: boolean };
};

export function createLLMDrafterConfigStore(opts: {
  llm: any;
  initialValues?: Record<string, unknown>;
  onConfigChange?: (config: any) => void;
}): PlannerConfigStore {
  const store = create<LLMDrafterConfigState & LLMDrafterConfigActions>((set, get) => ({
    // Initial state
    fields: createLLMDrafterFields(),
    models: [],
    initialized: false,

    // Initialize from saved values or URL
    initialize: async (values) => {
      console.log('[LLM Drafter] initialize: Starting with values:', values);

      // Load models first
      await get().loadModels();

      // Set saved values directly (without triggering callbacks during init)
      set(s => {
        let updatedFields = s.fields;

        if (values.model) {
          updatedFields = updateField(updatedFields, 'model', String(values.model));
          console.log('[LLM Drafter] initialize: Set model to:', values.model);
        }

        if (values.systemAppend) {
          updatedFields = updateField(updatedFields, 'systemAppend', String(values.systemAppend));
          console.log('[LLM Drafter] initialize: Set systemAppend to:', values.systemAppend);
        }

        if (values.targetWords !== undefined) {
          const num = Number(values.targetWords);
          const error = num < 0 || (num !== 0 && (num < 10 || num > 1000))
            ? 'Enter 0 to disable, or a number between 10 and 1000'
            : null;
          updatedFields = updateField(updatedFields, 'targetWords', num, error);
          console.log('[LLM Drafter] initialize: Set targetWords to:', num);
        }

        console.log('[LLM Drafter] initialize: Final fields:', updatedFields);
        return { fields: updatedFields, initialized: true };
      });
    },

    // Load available models
    loadModels: async () => {
      console.log('[LLM Drafter] loadModels: Starting to load models');
      set(s => ({
        fields: s.fields.map(f =>
          f.key === 'model' ? { ...f, pending: true } : f
        )
      }));

      try {
        const models = await getAvailableModels(opts.llm);
        console.log('[LLM Drafter] loadModels: Got models from provider:', models);

        set(s => {
          const updatedFields = s.fields.map(f =>
            f.key === 'model'
              ? {
                  ...f,
                  options: models.map(m => ({ value: m, label: m })),
                  value: f.value || models[0] || '',
                  pending: false
                }
              : f
          );
          console.log('[LLM Drafter] loadModels: Updated model field:', updatedFields.find(f => f.key === 'model'));
          return {
            models,
            fields: updatedFields
          };
        });

        console.log('[LLM Drafter] loadModels: Successfully loaded models');
      } catch (error) {
        console.error('[LLM Drafter] loadModels: Error loading models:', error);
        set(s => ({
          fields: s.fields.map(f =>
            f.key === 'model'
              ? { ...f, pending: false, error: 'Failed to load models' }
              : f
          )
        }));
      }
    },

    // Field setters
    setModel: async (model) => {
      set(s => ({ fields: updateField(s.fields, 'model', model) }));
      opts.onConfigChange?.(get().exportConfig().config);
    },

    setSystemAppend: async (text) => {
      set(s => ({ fields: updateField(s.fields, 'systemAppend', text) }));
      opts.onConfigChange?.(get().exportConfig().config);
    },

    setTargetWords: async (count) => {
      const num = Number(count);
      const error = num < 0 || (num !== 0 && (num < 10 || num > 1000))
        ? 'Enter 0 to disable, or a number between 10 and 1000'
        : null;

      set(s => ({ fields: updateField(s.fields, 'targetWords', num, error) }));
      opts.onConfigChange?.(get().exportConfig().config);
    },

    // Generic field setter for UI
    setField: async (key, value) => {
      switch (key) {
        case 'model': return get().setModel(String(value));
        case 'systemAppend': return get().setSystemAppend(String(value));
        case 'targetWords': return get().setTargetWords(Number(value));
      }
    },

    // Export current config
    exportConfig: () => {
      const { fields } = get();
      const values = Object.fromEntries(
        fields.map(f => [f.key, f.value])
      );

      return {
        config: {
          model: values.model,
          systemAppend: values.systemAppend || '',
          targetWords: Number(values.targetWords) || 0
        },
        ready: !!(values.model)
      };
    }
  }));

  // Don't auto-initialize - let the UI handle initialization
  // This prevents conflicts between constructor init and UI init

  // Return the store facade expected by the UI
  return {
    get snap() {
      const { fields } = store.getState();
      const anyPending = fields.some(f => f.pending);
      const anyError = fields.some(f => f.error);
      const { config, ready } = store.getState().exportConfig();

      return {
        fields,
        canSave: ready && !anyPending && !anyError,
        pending: anyPending,
        dirty: true, // For now, assume dirty if not saved
        summary: config.model ? `Model: ${config.model}` : '',
        preview: {
          hasSystemAppend: !!(config.systemAppend && String(config.systemAppend).trim()),
          targetWords: config.targetWords
        }
      };
    },

    setField: (key, value) => store.getState().setField(key, value),
    exportConfig: () => store.getState().exportConfig(),
    initialize: (values) => store.getState().initialize(values),
    destroy: () => {
      // Zustand stores don't need explicit destruction
    },

    subscribe: (listener) => store.subscribe(listener)
  };
}

// Helper functions
async function getAvailableModels(llm: any): Promise<string[]> {
  try {
    const models = await llm?.listModels?.();
    return Array.isArray(models) && models.length > 0 ? models : ['openai/gpt-oss-120b:nitro'];
  } catch {
    return ['openai/gpt-oss-120b:nitro'];
  }
}
