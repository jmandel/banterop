import React from 'react';
import { useAppStore } from '../state/store';
import { resolvePlanner } from '../planner/registry';

export function PlannerSetupCard() {
  const pid = useAppStore(s => s.plannerId);
  const planner = resolvePlanner(pid);
  const ready = useAppStore(s => !!s.readyByPlanner[pid]);
  const taskId = useAppStore(s => s.taskId);
  const role = useAppStore(s => s.role);
  const hud = useAppStore(s => s.hud);

  // Use the new clean config store system
  const configStore = useAppStore(s => s.configStores[pid]);

  // Track planner changes and expansion state
  const [lastPlannerId, setLastPlannerId] = React.useState<string>('');
  const [isNewPlanner, setIsNewPlanner] = React.useState<boolean>(false);
  const [collapsed, setCollapsed] = React.useState<boolean>(true);
  const [isExpanding, setIsExpanding] = React.useState<boolean>(false);
  const [wasReadyWhenSwitched, setWasReadyWhenSwitched] = React.useState<boolean>(false);

  // Expand when planner changes OR when newly selected
  React.useEffect(() => {
    const plannerChanged = lastPlannerId !== pid;
    console.log('[PlannerSetupCard] useEffect triggered:', {
      pid,
      lastPlannerId,
      plannerChanged,
      ready,
      isNewPlanner,
      isExpanding,
      currentCollapsed: collapsed
    });

    if (plannerChanged) {
      // Different planner selected - expand to show its config
      // Track if it was already ready when we switched
      const alreadyReady = ready;
      console.log('[PlannerSetupCard] Planner changed from', lastPlannerId, 'to', pid, '- expanding config (was ready:', alreadyReady, ')');

      setLastPlannerId(pid);
      setIsNewPlanner(true);
      setWasReadyWhenSwitched(alreadyReady);
      setIsExpanding(true);
      setCollapsed(false);

      // Allow collapse after a short delay to let auto-apply finish
      setTimeout(() => {
        console.log('[PlannerSetupCard] Expansion phase complete, allowing collapse');
        setIsExpanding(false);
      }, 100);
    } else if (!ready && !isNewPlanner && !isExpanding) {
      // Same planner but not configured yet - expand
      console.log('[PlannerSetupCard] Same planner but not ready - expanding config');
      setIsNewPlanner(true);
      setCollapsed(false);
    } else if (isNewPlanner && ready && !plannerChanged && !isExpanding && !wasReadyWhenSwitched) {
      // Allow collapsing once configured, but NOT during expansion phase
      // AND NOT if it was already ready when we switched
      console.log('[PlannerSetupCard] Planner configured - allowing collapse');
      setIsNewPlanner(false);
      setCollapsed(true);
    }
  }, [pid, ready, isNewPlanner, lastPlannerId, collapsed, isExpanding]);

  // Get config snapshot from store (reactive) - manual subscription to avoid hook issues
  const [configSnapshot, setConfigSnapshot] = React.useState(
    configStore?.snap || { fields: [], canSave: false, pending: false, dirty: false }
  );

  // Subscribe to config store changes
  React.useEffect(() => {
    if (!configStore) {
      setConfigSnapshot({ fields: [], canSave: false, pending: false, dirty: false });
      return;
    }

    // Update immediately
    setConfigSnapshot(configStore.snap);

    // Subscribe to future changes
    const unsubscribe = configStore.subscribe(() => {
      setConfigSnapshot(configStore.snap);
    });

    return unsubscribe;
  }, [configStore]);

  // Track last applied config to detect changes
  const [lastAppliedConfig, setLastAppliedConfig] = React.useState<any>(null);

  // Get current config for comparison
  const currentConfig = React.useMemo(() => {
    if (!configStore) return null;
    try {
      return configStore.exportConfig().config;
    } catch {
      return null;
    }
  }, [configStore]);

  // Check if current config differs from last applied
  const hasChanges = React.useMemo(() => {
    if (!currentConfig) return false;
    if (!lastAppliedConfig) return true; // No previous config means this is new/changed

    try {
      return JSON.stringify(currentConfig) !== JSON.stringify(lastAppliedConfig);
    } catch {
      return false;
    }
  }, [currentConfig, lastAppliedConfig]);

  console.log('[PlannerSetupCard] Render:', {
    pid,
    plannerName: planner?.name || 'none',
    plannerId: planner?.id || 'none',
    ready,
    isNewPlanner,
    collapsed,
    lastPlannerId,
    hasConfigStore: !!configStore,
    shouldShowFields: !collapsed,
    shouldShowSaveButton: !collapsed && (hasChanges || !ready)
  });

  console.log('[PlannerSetupCard] Config state:', {
    hasConfigStore: !!configStore,
    fieldsCount: configSnapshot?.fields?.length || 0,
    fields: configSnapshot?.fields?.map(f => ({ key: f.key, value: f.value, visible: f.visible, type: f.type })) || [],
    canSave: configSnapshot?.canSave,
    pending: configSnapshot?.pending,
    hasChanges,
    lastAppliedConfig: !!lastAppliedConfig
  });

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
    if (!configStore) return;

    setApplyErr(null);
    try {
      const { config, ready: rdy } = configStore.exportConfig();

      // Track the applied config for change detection
      setLastAppliedConfig(config);

      useAppStore.getState().reconfigurePlanner({ config, ready: rdy, rewind: true });
      setCollapsed(true);
    } catch (error: any) {
      setApplyErr(String(error?.message || 'Apply failed'));
    }
  }, [configStore]);

  // Don't render if no config store
  if (!configStore) {
    return (
      <div className="card" style={{ marginTop: 10 }}>
        <div className="small muted">This planner doesn't support configuration.</div>
      </div>
    );
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (configSnapshot?.pending) return;
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
        {configStore && (
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
        {!collapsed && (!ready || hasChanges) && (
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <button className="btn" type="submit" disabled={configSnapshot?.pending}>
              {ready ? 'Save Changes' : 'Save & Apply'}
            </button>
            {applyErr && <span className="small" style={{ color:'#b91c1c' }}>{applyErr}</span>}
          </div>
        )}
      </div>
      {!collapsed && (
        <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {configSnapshot?.fields?.filter(f => f.visible !== false).map(f => (
            <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 680 }}>
              <label className="small" style={{ fontWeight: 600 }}>{f.label}</label>
              {renderField(f, (k, v) => configStore.setField(k, v))}
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

  if (f.type === 'text') return <input
    className="input"
    value={String(f.value || '')}
    placeholder={f.placeholder || ''}
    onChange={e => handleFieldChange(f.key, e.target.value)}
  />;
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
