import type { PlannerConfigStore, ConfigSnapshot } from '../planner/config/types';
import type { PlannerFieldsVM, Field, ReduceEvent, Patch } from './types';
import { applyPatches } from './applyPatches';

export function makeConfigStore<Seed, Full>(
  vm: PlannerFieldsVM<Seed, Full>,
  opts?: { onConfigChange?: (config: Full | null) => void }
): PlannerConfigStore & { initializeFromSeed?: (seed: Seed) => Promise<void> } {
  // Store state
  let currentFields: Field[] = vm.baseFields();
  let subscribers = new Set<() => void>();

  // Context for async operations
  const effectCtx = {
    fetchJson: async (url: string) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`Fetch failed: ${response.status}`);
      const MAX = 1_500_000;
      const text = await response.text();
      if (text.length > MAX) throw new Error('Response exceeds 1.5 MB limit');
      try { return JSON.parse(text); } catch { throw new Error('Invalid JSON'); }
    },
    cache: new Map<string, any>()
  };

  // Notify subscribers
  const notify = () => {
    subscribers.forEach(cb => cb());
  };

  // Handle async effects
  const runEffects = async (effects: any[]) => {
    for (const effect of effects) {
      try {
        const data = await effect.run(effectCtx);

        // Send result back to VM
        const resultEvent: ReduceEvent = {
          type: 'ASYNC_RESULT',
          token: effect.token,
          data
        };
        const result = vm.reduce(currentFields, resultEvent);

        // Apply patches
        if (result.patches) {
          currentFields = applyPatches(currentFields, result.patches);
          notify();
        }
      } catch (error: any) {
        // Send error back to VM
        const errorEvent: ReduceEvent = {
          type: 'ASYNC_ERROR',
          token: effect.token,
          error: error.message
        };
        const result = vm.reduce(currentFields, errorEvent);

        // Apply patches
        if (result.patches) {
          currentFields = applyPatches(currentFields, result.patches);
          notify();
        }
      }
    }
  };

  // Dispatch BOOT on creation so VMs can populate async model lists, etc.
  (async () => {
    try {
      const boot = vm.reduce(currentFields, { type: 'BOOT' });
      if (boot.patches) {
        currentFields = applyPatches(currentFields, boot.patches);
        notify();
      }
      if (boot.effects) {
        await runEffects(boot.effects);
      }
      // Propagate initial config if valid
      try {
        const v = vm.validateToFull(currentFields);
        opts?.onConfigChange?.(v.ok ? (v.full as Full) : null);
      } catch { opts?.onConfigChange?.(null); }
    } catch {
      // ignore BOOT errors
    }
  })();

  return {
    get snap(): ConfigSnapshot {
      return {
        fields: currentFields,
        canSave: vm.validateToFull(currentFields).ok,
        pending: currentFields.some(f => f.pending),
        dirty: true, // Assume dirty for now
        summary: undefined,
        preview: undefined
      };
    },

    setField: async (key: string, value: unknown) => {
      // Send field change to VM
      const event: ReduceEvent = {
        type: 'FIELD_CHANGE',
        key,
        value
      };
      const result = vm.reduce(currentFields, event);

      // Apply immediate patches
      if (result.patches) {
        currentFields = applyPatches(currentFields, result.patches);
        notify();
      }

      // Handle async effects
      if (result.effects) {
        await runEffects(result.effects);
      }

      // Emit latest (partial) config snapshot to host if valid
      try {
        const v = vm.validateToFull(currentFields);
        opts?.onConfigChange?.(v.ok ? v.full : null);
      } catch {
        opts?.onConfigChange?.(null);
      }
    },

    exportConfig: () => {
      const validation = vm.validateToFull(currentFields);
      if (!validation.ok) {
        return {
          config: {},
          ready: false,
          savedFields: currentFields.map(f => ({ key: f.key, value: f.value }))
        };
      }

      return {
        config: validation.full,
        ready: true,
        savedFields: currentFields.map(f => ({ key: f.key, value: f.value }))
      };
    },

    destroy: () => {
      subscribers.clear();
    },

    subscribe: (listener) => {
      subscribers.add(listener);
      return () => subscribers.delete(listener);
    },

    initializeFromSeed: async (seed) => {
      console.log('[makeConfigStore] will try fastforward Initializing from seed:', seed);
      try {
        if (vm.fastForward) {
          const { fields } = await vm.fastForward(seed as any, effectCtx);
          currentFields = fields;
          // Emit best-effort live config to URL sync / previews
          try {
            const v = vm.validateToFull(currentFields);
            opts?.onConfigChange?.(v.ok ? (v.full as Full) : null);
          } catch { opts?.onConfigChange?.(null); }
          notify();
        }
      } catch {
        // ignore: fallback is base fields
      }
    }
  };
}
