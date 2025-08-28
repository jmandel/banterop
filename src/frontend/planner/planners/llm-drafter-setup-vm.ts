import type { PlannerFieldsVM, Field, ReduceResult, Patch } from '../../setup-vm/types';
import { fetchJsonCapped } from '../../../shared/net';

export type LLMDrafterSeedV1 = {
  v: 1;
  model?: string;
  systemAppend?: string;
  targetWords?: number;
};

export type FullConfig = {
  model: string;
  systemAppend: string;
  targetWords: number;
};

// Constants
const CURATED_MODELS = ['openai/gpt-oss-120b:nitro', 'qwen/qwen3-235b-a22b-2507:nitro'];

// Helper functions
function findField(fs: Field[], key: string): Field | undefined {
  return fs.find(f => f.key === key);
}

function options(list: string[]): Array<{ value: string; label: string }> {
  return list.map(v => ({ value: v, label: v }));
}

function validateTargetWords(value: unknown): string | null {
  const num = Number(value);
  if (isNaN(num) || num < 0) {
    return 'Must be 0 or greater';
  }
  if (num !== 0 && (num < 10 || num > 1000)) {
    return 'Must be 0 to disable, or 10-1000';
  }
  return null;
}

// VM Implementation
export function createLLMDrafterSetupVM(): PlannerFieldsVM<LLMDrafterSeedV1, FullConfig> {
  return {
    id: 'llm-drafter-v1',

    baseFields(): Field[] {
      return [
        { key: 'model', type: 'select', label: 'Model', value: CURATED_MODELS[0], options: options(CURATED_MODELS) },
        { key: 'systemAppend', type: 'text', label: 'System prompt (append)', value: '', placeholder: 'Optional: appended to built-in system prompt' },
        { key: 'targetWords', type: 'text', label: 'Target word count', value: '0', placeholder: '0 to disable, or positive number' },
      ];
    },

    reduce(current, ev): ReduceResult {
      const patches: Patch[] = [];

      if (ev.type === 'BOOT') {
        return { patches };
      }

      if (ev.type === 'FIELD_CHANGE') {
        const { key, value } = ev;
        patches.push({ op: 'setFieldValue', key, value });

        if (key === 'targetWords') {
          // Validate target words
          const error = validateTargetWords(value);
          patches.push({ op: 'setFieldError', key: 'targetWords', error });
        }

        return { patches };
      }

      if (ev.type === 'ASYNC_RESULT') {
        // LLM Drafter doesn't have async operations in this simple version
        return { patches };
      }

      if (ev.type === 'ASYNC_ERROR') {
        // Handle any async errors
        return { patches };
      }

      return { patches };
    },

    // Fast-forward from seed (for deep-linking)
    async fastForward(seed, ctx) {
      const model = String(seed?.model || CURATED_MODELS[0]);
      const systemAppend = String(seed?.systemAppend || '');
      const targetWordsRaw = seed?.targetWords ?? 0;
      const targetWords = Math.max(0, Math.min(1000, Number(targetWordsRaw) || 0));
      const targetWordsError = validateTargetWords(targetWords);

      const fields: Field[] = [
        { key: 'model', type: 'select', label: 'Model', value: model, options: options(CURATED_MODELS) },
        { key: 'systemAppend', type: 'text', label: 'System prompt (append)', value: systemAppend, placeholder: 'Optional: appended to built-in system prompt' },
        { key: 'targetWords', type: 'text', label: 'Target word count', value: String(targetWords), placeholder: '0 to disable, or positive number', error: targetWordsError },
      ];

      const full: FullConfig = { model, systemAppend, targetWords };
      return { fields, full };
    },

    // Validate fields to FullConfig
    validateToFull(fields) {
      const by = (k: string) => findField(fields, k);
      const model = String((by('model') as any)?.value || CURATED_MODELS[0]);
      const systemAppend = String((by('systemAppend') as any)?.value || '');
      const targetWordsRaw = String((by('targetWords') as any)?.value || '0');
      const targetWords = Math.max(0, Math.min(1000, Number(targetWordsRaw) || 0));

      const targetWordsError = validateTargetWords(targetWords);
      if (targetWordsError) {
        return { ok: false, errors: [{ key: 'targetWords', msg: targetWordsError }] };
      }

      const full: FullConfig = { model, systemAppend, targetWords };
      return { ok: true, full };
    },

    // Convert FullConfig to compact seed
    dehydrate(full) {
      const seed: LLMDrafterSeedV1 = { v: 1 };
      if (full.model && full.model !== CURATED_MODELS[0]) {
        (seed as any).model = full.model;
      }
      if (full.systemAppend && full.systemAppend.trim()) {
        (seed as any).systemAppend = full.systemAppend.trim();
      }
      if (full.targetWords && full.targetWords !== 0) {
        (seed as any).targetWords = full.targetWords;
      }
      return seed;
    },

    // Convert seed to FullConfig (for startUrlSync)
    async hydrate(seed, ctx) {
      const model = String(seed?.model || CURATED_MODELS[0]);
      const systemAppend = String(seed?.systemAppend || '');
      const targetWordsRaw = seed?.targetWords ?? 0;
      const targetWords = Math.max(0, Math.min(1000, Number(targetWordsRaw) || 0));

      const full: FullConfig = { model, systemAppend, targetWords };
      return { full };
    }
  };
}

// Replace the existing config methods with VM-based ones
import { LLMDrafterPlanner } from './llm-drafter';

const vm = createLLMDrafterSetupVM();

// Replace existing config methods with VM-based ones
;(LLMDrafterPlanner as any).createSetupVM = () => vm;
;(LLMDrafterPlanner as any).dehydrate = (config: FullConfig) => vm.dehydrate(config);
;(LLMDrafterPlanner as any).hydrate = async (seed: LLMDrafterSeedV1, ctx: any) => vm.hydrate(seed, ctx);

// Ensure the VM is properly attached
console.log('[llm-drafter-setup-vm] Attached VM to planner:', LLMDrafterPlanner.id);

// Remove the old config store method to force VM usage
if ((LLMDrafterPlanner as any).createConfigStore) {
  delete (LLMDrafterPlanner as any).createConfigStore;
  console.log('[llm-drafter-setup-vm] Removed old createConfigStore method');
}
