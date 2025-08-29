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

  // Use the setup UI state machine from the store
  const setupUi = useAppStore(s => s.setupUi);
  const collapsed = setupUi.panel === 'collapsed';

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
  const canShowBegin = canBegin && (hud?.phase === 'idle' || !hud) && !hasUnsentDraft && collapsed;

  const saveApply = React.useCallback(async () => {
    if (!configStore) return;

    setApplyErr(null);
    try {
      const { config, ready: rdy } = configStore.exportConfig();

      // Track the applied config for change detection
      setLastAppliedConfig(config);

      useAppStore.getState().reconfigurePlanner({ config, ready: rdy, rewind: true });
      useAppStore.getState().onApplyClicked();
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
            onClick={() => {
              const { openSetup, collapseSetup } = useAppStore.getState();
              collapsed ? openSetup() : collapseSetup();
            }}
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
            // Emphasize actual info: for tools → "name(args)"; otherwise show raw label or minimal phase
            const compactArgs = (() => {
              if (!argsText) return '';
              try {
                const obj = JSON.parse(argsText);
                const keys = Object.keys(obj || {});
                const preview = keys.slice(0, 3).map(k => `${k}:${JSON.stringify(obj[k])}`).join(', ');
                return `(${preview}${keys.length > 3 ? ', …' : ''})`;
              } catch { return `(${argsText.length > 40 ? argsText.slice(0, 37) + '…' : argsText})`; }
            })();
            const pillText = isTool
              ? [name || 'tool', compactArgs].filter(Boolean).join(' ')
              : (raw || (phase === 'idle' ? (planner?.name ? `Idle — ${planner.name}` : 'Idle') : phase));

            return (<span className="pill" title={raw || undefined}>{pillText}</span>);
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
  if (f.type === 'select') {
    const hasGroups = Array.isArray((f as any).groups) && (f as any).groups.length > 0;
    if (hasGroups) {
      const groups = (f as any).groups as Array<{ label:string; options:Array<{value:string; label:string}> }>;
      return (
        <select className="input" value={String(f.value || '')} onChange={e => handleFieldChange(f.key, e.target.value)}>
          {groups.map(g => (
            <optgroup key={g.label || 'group'} label={g.label || ''}>
              {g.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </optgroup>
          ))}
        </select>
      );
    }
    return (
      <select className="input" value={String(f.value || '')} onChange={e => handleFieldChange(f.key, e.target.value)}>
        {(f.options || []).map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
    );
  }
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
