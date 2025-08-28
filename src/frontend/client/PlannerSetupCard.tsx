import React from 'react';
import { useAppStore } from '../state/store';
import { resolvePlanner } from '../planner/registry';
import { useSetupVM } from '../setup-vm/useSetupVM';
import type { PlannerFieldsVM } from '../setup-vm/types';

export function PlannerSetupCard() {
  const pid = useAppStore(s => s.plannerId);
  const planner = resolvePlanner(pid);
  const ready = useAppStore(s => !!s.readyByPlanner[pid]);
  const taskId = useAppStore(s => s.taskId);
  const role = useAppStore(s => s.role);
  const hud = useAppStore(s => s.hud);
  const [collapsed, setCollapsed] = React.useState<boolean>(ready);

  console.log('[PlannerSetupCard] Render:', {
    pid,
    plannerName: planner?.name || 'none',
    plannerId: planner?.id || 'none',
    ready,
    hasCreateSetupVM: !!(planner && typeof (planner as any).createSetupVM === 'function'),
    hasCreateConfigStore: !!(planner && typeof (planner as any).createConfigStore === 'function')
  });

  // Only allow collapsing when configured; expand when not ready
  React.useEffect(() => {
    console.log('[PlannerSetupCard] Ready state changed:', ready, 'setting collapsed to:', !!ready);
    setCollapsed(!!ready);
  }, [ready]);

  // Extract seed from URL hash
  const seed = React.useMemo(() => {
    try {
      const hash = window.location.hash.slice(1);
      const urlParams = new URLSearchParams(hash);
      const setupParam = urlParams.get('setup');

      if (setupParam) {
        const setupData = JSON.parse(setupParam);
        console.log('[PlannerSetupCard] Parsed setup data:', setupData);
        return setupData.planner?.seed || setupData.seed;
      }

      // Fallback to individual parameters
      const seed: Record<string, unknown> = {};
      for (const [key, value] of urlParams.entries()) {
        if (key !== 'planner') {
          seed[key] = value;
        }
      }
      return Object.keys(seed).length > 0 ? seed : undefined;
    } catch (error) {
      console.error('[PlannerSetupCard] Failed to parse URL seed:', error);
      return undefined;
    }
  }, []);

  // Prefer new VM contract, fallback to legacy store
  const vm: PlannerFieldsVM<any, any> | null = React.useMemo(() => {
    if (planner && typeof (planner as any).createSetupVM === 'function') {
      const vmInstance = (planner as any).createSetupVM();
      console.log('[PlannerSetupCard] Created VM:', vmInstance.id, 'with base fields:', vmInstance.baseFields());
      return vmInstance;
    }
    return null;
  }, [planner]);

  const { fields, dispatch, pending, loadedFromSeed } = useSetupVM(vm, seed);

  console.log('[PlannerSetupCard] VM state:', {
    hasVM: !!vm,
    fieldsCount: fields.length,
    fields: fields.map(f => ({ key: f.key, value: f.value, visible: f.visible, type: f.type })),
    seed,
    pending,
    loadedFromSeed
  });

  // Auto-apply config when loaded from URL seed
  React.useEffect(() => {
    if (loadedFromSeed && vm && fields.length > 0 && !ready) {
      console.log('[PlannerSetupCard] Auto-applying config from URL seed');
      saveApply();
    }
  }, [loadedFromSeed, vm, fields.length, ready]);
  const [applyErr, setApplyErr] = React.useState<string | null>(null);

  const canBegin = ready && role === 'initiator' && !taskId;
  const facts = useAppStore(s => s.facts);
  const hasUnsentDraft = React.useMemo(() => {
    const dismissed = new Set<string>(facts.filter(f=>f.type==='compose_dismissed').map((f:any)=>String(f.composeId||'')));
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'compose_intent') {
        const cid = String((f as any).composeId||'');
        if (cid && !dismissed.has(cid)) {
          let sentAfter = false;
          for (let j = i + 1; j < facts.length; j++) {
            if (facts[j].type === 'remote_sent') { sentAfter = true; break; }
          }
          if (!sentAfter) return true;
        }
      }
    }
    return false;
  }, [facts]);
  const canShowBegin = canBegin && (hud?.phase === 'idle' || !hud) && !hasUnsentDraft;

  const saveApply = React.useCallback(async () => {
    setApplyErr(null);
    try {
      if (vm) {
        // Use new VM validation
        const v = vm.validateToFull(fields);
        if (!v.ok) {
          const errs = v.errors || [];
          setApplyErr(errs.map(e => e.msg).join(' · '));
          return;
        }
        useAppStore.getState().reconfigurePlanner({ config: v.full, ready: true, rewind: true });
        setCollapsed(true);
        return;
      }

      // Fallback to legacy store for planners not yet migrated
      if (typeof (planner as any).createConfigStore === 'function') {
        const saved = useAppStore.getState().savedFieldsByPlanner?.[pid];
        const initial = useAppStore.getState().configByPlanner?.[pid];
        const store = (planner as any).createConfigStore({
          llm: {}, // TODO: get actual LLM provider
          savedFields: saved,
          initial
        });
        const { config, ready: rdy } = store.exportFullConfig();
        useAppStore.getState().reconfigurePlanner({ config, ready: rdy, rewind: true });
        if (saved) useAppStore.getState().setPlannerSavedFields(saved);
        store.destroy?.();
        setCollapsed(true);
        return;
      }

      setApplyErr('Planner has no setup VM nor legacy config store.');
    } catch (error: any) {
      setApplyErr(String(error?.message || 'Apply failed'));
    }
  }, [vm, fields, pid, planner]);

  // Don't render if no VM and no legacy store
  if (!vm && typeof (planner as any).createConfigStore !== 'function') {
    return (
      <div className="card" style={{ marginTop: 10 }}>
        <div className="small muted">This planner doesn't support configuration.</div>
      </div>
    );
  }

  // Show legacy fallback message for non-migrated planners
  if (!vm && typeof (planner as any).createConfigStore === 'function') {
    return (
      <div className="card" style={{ marginTop: 10 }}>
        <div className="small muted">This planner uses the legacy config store. (Scenario Planner uses the new Setup VM.)</div>
      </div>
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    saveApply();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Enter') return;

    const t = e.target as any;
    const tag = String((t?.tagName || '')).toUpperCase();
    const type = String(t?.type || '').toLowerCase();
    const isTextInput = tag === 'INPUT' && type === 'text';
    const isTextarea = tag === 'TEXTAREA';

    if (!isTextInput && !isTextarea) {
      e.preventDefault();
      handleSubmit(e as any);
    }
  }

  return (
    <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="card" style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {ready && (
          <button
            className="btn ghost"
            type="button"
            onClick={() => setCollapsed(v => !v)}
            aria-label={collapsed ? 'Expand planner setup' : 'Collapse planner setup'}
            style={{ fontSize: 18, width: 34, height: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
          >
            {collapsed ? '▸' : '▾'}
          </button>
        )}
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {ready && (
            (hud && hud.phase && hud.phase !== 'idle')
              ? <span className="working-dot" aria-label="Working" title="Working" />
              : <span className="idle-dot" aria-label="Ready" title="Ready" />
          )}
          {(() => {
            const phase = hud?.phase || 'idle';
            const raw = String(hud?.label || '').trim();
            const isTool = phase === 'tool';
            let name: string | null = null;
            let argsText: string | null = null;
            if (isTool && raw) {
              const m1 = raw.match(/^Tool:\s*([^\(\s]+)\s*\((.*)\)\s*$/);
              if (m1) { name = m1[1]; argsText = m1[2]; }
              else {
                const m2 = raw.match(/^Executing\s+([^\s]+)\s*$/);
                if (m2) { name = m2[1]; }
                else {
                  const m3 = raw.match(/^([^\(\s]+)\s*\((.*)\)\s*$/);
                  if (m3) { name = m3[1]; argsText = m3[2]; }
                }
              }
            }
            const pillText = (() => {
              if (isTool) return `Tool — ${raw && raw.startsWith('Executing') ? raw : (name ? `Executing ${name}` : 'Executing')}`;
              if (phase === 'idle') return 'Idle';
              const cap = phase.slice(0,1).toUpperCase() + phase.slice(1);
              return raw ? `${cap} — ${raw}` : cap;
            })();
            let tooltip: string | undefined;
            if (isTool && name) {
              let parsed: any = undefined;
              try { if (argsText) parsed = JSON.parse(argsText); } catch {}
              const fullObj: any = { name, args: parsed ?? (argsText ? String(argsText) : {}) };
              try { tooltip = JSON.stringify(fullObj, null, 2); } catch {}
            }
            return (
              <>
                <span className="pill">{pillText}</span>
                {isTool && name && (
                  <span className="hud-json" title={tooltip || `{\n  \"name\": \"${name}\",\n  \"args\": ${argsText ? argsText : '{}'}\n}`}>
                    {`{\"name\":\"${name}\", \"args\": ${argsText ? argsText : '{}'}}`}
                  </span>
                )}
              </>
            );
          })()}
        </div>
        {canShowBegin && <button className="btn" type="button" onClick={() => useAppStore.getState().kickoffConversationWithPlanner()}>Begin conversation</button>}
        {!collapsed && (
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <button className="btn" type="submit" disabled={pending}>Save & Apply</button>
            {applyErr && <span className="small" style={{ color:'#b91c1c' }}>{applyErr}</span>}
          </div>
        )}
      </div>
      {!collapsed && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {fields.filter(f => f.visible !== false).map(f => (
            <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 680 }}>
              <label className="small" style={{ fontWeight: 600 }}>{f.label}</label>
              {renderField(f, (k, v) => dispatch({ type: 'FIELD_CHANGE', key: k, value: v }))}
              {f.error && <div className="small" style={{ color: '#c62828' }}>{f.error}</div>}
            </div>
          ))}
        </div>
      )}
    </form>
  );
}

function renderField(f: any, setField: (k: string, v: any) => void) {
  const handleFieldChange = (key: string, value: any) => {
    console.log(`[PlannerSetupCard] Field ${key} changing from "${f.value}" to "${value}"`);
    setField(key, value);
  };

  if (f.type === 'text') return <input className="input" value={String(f.value || '')} placeholder={f.placeholder || ''} onChange={e => handleFieldChange(f.key, e.target.value)} />;
  if (f.type === 'checkbox') return (<input type="checkbox" checked={!!f.value} onChange={e => handleFieldChange(f.key, e.target.checked)} />);
  if (f.type === 'select') return <select className="input" value={String(f.value || '')} onChange={e => handleFieldChange(f.key, e.target.value)}>{(f.options || []).map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
  if (f.type === 'checkbox-group') {
    const sel = new Set<string>(Array.isArray(f.value) ? f.value : []);
    const toggle = (v: string) => {
      const next = new Set(sel);
      next.has(v) ? next.delete(v) : next.add(v);
      handleFieldChange(f.key, Array.from(next));
    };
    return (
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px,1fr))', gap: 8 }}>
        {(f.options || []).map((o: any) => (
          <label key={o.value} className="small" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <input type="checkbox" checked={sel.has(o.value)} onChange={() => toggle(o.value)} /> {o.label}
          </label>
        ))}
      </div>
    );
  }
  return null;
}
