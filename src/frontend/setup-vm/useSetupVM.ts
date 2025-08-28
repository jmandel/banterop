import * as React from 'react';
import type { PlannerFieldsVM, Field, Event, EffectCtx } from './types';
import { applyPatches } from './applyPatches';

const globalCache = new Map<string, any>();

export function useSetupVM<Seed, Full>(vm: PlannerFieldsVM<Seed, Full> | null, seed?: Seed) {
  const [fields, setFields] = React.useState<Field[]>(vm ? vm.baseFields() : []);
  const [pendingTokens, setPending] = React.useState<Set<string>>(new Set());
  const [loadedFromSeed, setLoadedFromSeed] = React.useState<boolean>(false);
  const fieldsRef = React.useRef(fields);
  fieldsRef.current = fields;

  const effectCtx: EffectCtx = React.useMemo(() => ({
    fetchJson: async (u: string) => {
      const key = `json:${u}`;
      if (globalCache.has(key)) return globalCache.get(key);
      const res = await fetch(u, { method: 'GET' });
      if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
      const text = await res.text();
      const MAX = 1_500_000;
      if (text.length > MAX) throw new Error('Response exceeds size limit');
      const data = JSON.parse(text);
      globalCache.set(key, data);
      return data;
    },
    cache: globalCache
  }), []);

  // Initialize fields on VM change or seed change
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!vm) {
        setFields([]);
        setLoadedFromSeed(false);
        return;
      }

      try {
        let initialFields: Field[];
        let fromSeed = false;

        if (seed != null) {
          // Use fast-forward when we have a seed
          const { fields: ff } = await vm.fastForward(seed, effectCtx);
          initialFields = ff;
          fromSeed = true;
        } else {
          // Use base fields when no seed
          initialFields = vm.baseFields();
          fromSeed = false;
        }

        if (!cancelled) {
          setFields(initialFields);
          setLoadedFromSeed(fromSeed);
        }
      } catch (error) {
        console.warn('[useSetupVM] Initialization failed:', error);
        // Fallback to base fields on error
        if (!cancelled) {
          setFields(vm.baseFields());
          setLoadedFromSeed(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [vm, JSON.stringify(seed), effectCtx]);

  const runEffects = React.useCallback(async (evOut: ReturnType<PlannerFieldsVM<any, any>['reduce']>) => {
    const effects = evOut.effects || [];
    if (!effects.length) return;

    // Mark tokens as pending
    setPending(prev => {
      const next = new Set(prev);
      for (const e of effects) next.add(e.token);
      return next;
    });

    for (const e of effects) {
      try {
        const data = await e.run(effectCtx);
        const r = vm!.reduce(fieldsRef.current, { type: 'ASYNC_RESULT', token: e.token, data });
        setFields(f => applyPatches(f, r.patches));
      } catch (error: any) {
        const r = vm!.reduce(fieldsRef.current, { type: 'ASYNC_ERROR', token: e.token, error: String(error?.message || 'error') });
        setFields(f => applyPatches(f, r.patches));
      } finally {
        setPending(prev => {
          const next = new Set(prev);
          next.delete(e.token);
          return next;
        });
      }
    }
  }, [vm, effectCtx]);

  const dispatch = React.useCallback((ev: Event) => {
    if (!vm) return;
    const r = vm.reduce(fieldsRef.current, ev);
    setFields(f => applyPatches(f, r.patches));
    void runEffects(r);
  }, [vm, runEffects]);

  const pending = pendingTokens.size > 0;
  return { fields, dispatch, pending, loadedFromSeed };
}
