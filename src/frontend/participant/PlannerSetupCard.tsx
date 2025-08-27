import React from 'react';
import { useAppStore } from '../state/store';
import { resolvePlanner } from '../planner/registry';
import { makeChitchatProvider, DEFAULT_CHITCHAT_ENDPOINT } from '../../shared/llm-provider';

export function PlannerSetupCard({ urlSetup }: { urlSetup: any | null }) {
  const pid = useAppStore(s => s.plannerId);
  const planner: any = resolvePlanner(pid);
  const applied = useAppStore(s => s.appliedByPlanner[pid]);
  const ready = useAppStore(s => !!s.readyByPlanner[pid]);
  const taskId = useAppStore(s => s.taskId);
  const role = useAppStore(s => s.role);
  const hud = useAppStore(s => s.hud);
  const [collapsed, setCollapsed] = React.useState<boolean>(ready);

  React.useEffect(() => { if (ready) setCollapsed(true); }, [ready]);

  const llm = React.useMemo(() => makeChitchatProvider(DEFAULT_CHITCHAT_ENDPOINT), []);
  const [cfg, setCfg] = React.useState<any>(null);
  const plannerKey = planner && typeof planner.id === 'string' ? String(planner.id) : 'none';
  const urlInitial = React.useMemo(() => {
    const u = urlSetup && urlSetup.planner && urlSetup.planner.id === pid ? (urlSetup.planner.applied || urlSetup.planner.config) : null;
    if (u && urlSetup?.llm?.model && typeof u === 'object') { try { (u as any).model = String(urlSetup.llm.model || ''); } catch {} }
    return u;
  }, [urlSetup, pid]);

  const autoApplyRequested = !!(urlSetup && urlSetup.planner && urlSetup.planner.id === pid && urlSetup.planner.ready);

  React.useEffect(() => {
    if (planner && typeof (planner as any).createConfigStore === 'function') {
      const initialForCfg = applied || urlInitial || undefined;
      const s = (planner as any).createConfigStore({ llm, initial: initialForCfg });
      setCfg(s);
      return () => { try { s.destroy(); } catch {} };
    }
    setCfg(null);
    return () => {};
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [plannerKey, urlInitial]);

  const subscribe = React.useCallback((onStoreChange: () => void) => {
    if (cfg && typeof cfg.subscribe === 'function') return cfg.subscribe(onStoreChange);
    return () => {};
  }, [cfg]);
  const emptySnapRef = React.useRef<any>({ fields: [], canSave: false, pending: false, dirty: false });
  const getSnapshot = React.useCallback(() => cfg ? cfg.snap : emptySnapRef.current, [cfg]);
  const snap = React.useSyncExternalStore(subscribe, getSnapshot);

  const canBegin = ready && role === 'initiator' && !taskId;
  const [autoApplied, setAutoApplied] = React.useState(false);
  const kickoffPref = React.useMemo(() => {
    const ks = urlSetup && urlSetup.planner && urlSetup.planner.id === pid ? (urlSetup.kickoff || 'never') : 'never';
    return ks as 'never'|'always'|'if-ready';
  }, [urlSetup, pid]);
  const [kicked, setKicked] = React.useState(false);

  const save = React.useCallback(() => {
    if (!cfg) return;
    try {
      const { applied: appliedOut, ready: readyOut } = cfg.exportApplied();
      try { useAppStore.getState().setPlannerApplied(appliedOut, readyOut); } catch {
        useAppStore.setState((s: any) => ({
          appliedByPlanner: { ...s.appliedByPlanner, [pid]: appliedOut },
          readyByPlanner: { ...s.readyByPlanner, [pid]: readyOut },
        }));
      }
      setCollapsed(true);
    } catch {}
  }, [cfg, pid]);

  React.useEffect(() => {
    if (!cfg || !autoApplyRequested || autoApplied) return;
    const snapNow = cfg?.snap;
    if (snapNow && snapNow.canSave && !snapNow.pending) { try { save(); setAutoApplied(true); } catch {} }
  }, [cfg, autoApplyRequested, autoApplied, save, snap?.canSave, snap?.pending]);

  React.useEffect(() => {
    if (kicked) return;
    if (role !== 'initiator' || taskId) return;
    const shouldKick = kickoffPref === 'always' || (kickoffPref === 'if-ready' && ready);
    if (shouldKick) { try { useAppStore.getState().kickoffConversationWithPlanner(); setKicked(true); } catch {} }
  }, [kickoffPref, ready, role, taskId, kicked]);

  if (cfg) {
    function handleSubmit(e: React.FormEvent) { e.preventDefault(); if (!snap?.canSave || snap?.pending) return; save(); }
    function handleKeyDown(e: React.KeyboardEvent) {
      if (e.key !== 'Enter') return;
      const t = e.target as any; const tag = String((t?.tagName || '')).toUpperCase(); const type = String(t?.type || '').toLowerCase();
      const isTextInput = tag === 'INPUT' && type === 'text'; const isTextarea = tag === 'TEXTAREA';
      if (!isTextInput || isTextarea) { e.preventDefault(); }
    }
    return (
      <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="card" style={{ marginTop: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <button className="btn ghost" type="button" onClick={() => setCollapsed(v => !v)} aria-label={collapsed ? 'Expand planner setup' : 'Collapse planner setup'} style={{ fontSize: 18, width: 34, height: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            {collapsed ? '▸' : '▾'}
          </button>
          <strong>Planner — {planner?.name || '—'}</strong>
          <span className="small muted" style={{ marginLeft: 8 }}>
            {ready ? 'Ready' : 'Not configured'}
            {collapsed && ((planner as any)?.summarizeApplied?.(applied) || snap?.summary) ? ` • ${(planner as any)?.summarizeApplied?.(applied) || snap.summary}` : ''}
          </span>
          <span style={{ marginLeft: 'auto' }} />
          {hud && hud.phase !== 'idle' && (
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <span className="pill">{hud.phase}{hud.label ? ` — ${hud.label}` : ''}</span>
              {typeof hud.p === 'number' && (
                <div style={{ width: 160, height: 6, background: '#eef1f7', borderRadius: 4 }}>
                  <div style={{ width: `${Math.round(Math.max(0, Math.min(1, hud.p)) * 100)}%`, height: '100%', background: '#5b7cff', borderRadius: 4 }} />
                </div>
              )}
            </div>
          )}
          {!collapsed && (
            <button className="btn" type="submit" disabled={!snap?.canSave || snap?.pending}>Save & Apply</button>
          )}
          {canBegin && <button className="btn" onClick={() => useAppStore.getState().kickoffConversationWithPlanner()}>Begin conversation</button>}
        </div>
        {!collapsed && (
          <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {snap.fields.filter((f: any) => f.visible !== false).map((f: any) => (
              <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 680 }}>
                <label className="small" style={{ fontWeight: 600 }}>{f.label}</label>
                {renderField(f, cfg.setField)}
                {f.help && <div className="small muted">{f.help}</div>}
                {f.error && <div className="small" style={{ color: '#c62828' }}>{f.error}</div>}
                {f.pending && <div className="small muted">Validating…</div>}
              </div>
            ))}
            {snap.preview && <div className="small muted">Preview: {JSON.stringify(snap.preview)}</div>}
          </div>
        )}
      </form>
    );
  }
  return null;
}

function renderField(f: any, setField: (k: string, v: any) => void) {
  if (f.type === 'text') return <input className="input" value={String(f.value || '')} placeholder={f.placeholder || ''} onChange={e => setField(f.key, e.target.value)} />;
  if (f.type === 'checkbox') return (<input type="checkbox" checked={!!f.value} onChange={e => setField(f.key, e.target.checked)} />);
  if (f.type === 'select') return <select className="input" value={String(f.value || '')} onChange={e => setField(f.key, e.target.value)}>{(f.options || []).map((o: any) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
  if (f.type === 'checkbox-group') {
    const sel = new Set<string>(Array.isArray(f.value) ? f.value : []);
    const toggle = (v: string) => { const next = new Set(sel); next.has(v) ? next.delete(v) : next.add(v); setField(f.key, Array.from(next)); };
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

