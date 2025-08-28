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

  // Only allow collapsing when configured; expand when not ready
  React.useEffect(() => { setCollapsed(!!ready); }, [ready]);

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
  const [applyErr, setApplyErr] = React.useState<string | null>(null);
  const facts = useAppStore(s => s.facts);
  const hasUnsentDraft = React.useMemo(() => {
    const dismissed = new Set<string>(facts.filter(f=>f.type==='compose_dismissed').map((f:any)=>String(f.composeId||'')));
    for (let i = facts.length - 1; i >= 0; --i) {
      const f = facts[i];
      if (f.type === 'compose_intent') {
        const cid = String((f as any).composeId||'');
        if (cid && !dismissed.has(cid)) {
          // if any remote_sent appears after this compose, it's not unsent
          let sentAfter = false;
          for (let j = i + 1; j < facts.length; j++) { if (facts[j].type === 'remote_sent') { sentAfter = true; break; } }
          if (!sentAfter) return true;
        }
      }
    }
    return false;
  }, [facts]);
  const canShowBegin = canBegin && (hud?.phase === 'idle' || !hud) && !hasUnsentDraft;
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
      setApplyErr(null);
      try {
        // Always rewind on apply to ensure clean journal context
        useAppStore.getState().reconfigurePlanner({ applied: appliedOut, ready: readyOut, rewind: true });
      } catch (e:any) {
        setApplyErr(String(e?.message || 'Apply failed'));
        return;
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
          {ready && (
            <button className="btn ghost" type="button" onClick={() => setCollapsed(v => !v)} aria-label={collapsed ? 'Expand planner setup' : 'Collapse planner setup'} style={{ fontSize: 18, width: 34, height: 34, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
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
              // Normalize label for tool phase
              let name: string | null = null;
              let argsText: string | null = null;
              if (isTool && raw) {
                // Patterns to support: "Tool: name(argsJSON)", "Executing name", "name(argsJSON)"
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
              // Build tooltip (full pretty JSON) for tool inputs
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
          {canShowBegin && <button className="btn" onClick={() => useAppStore.getState().kickoffConversationWithPlanner()}>Begin conversation</button>}
          {!collapsed && (
            <div className="row" style={{ gap: 8, alignItems: 'center' }}>
              <button className="btn" type="submit" disabled={!snap?.canSave || snap?.pending}>Save & Apply</button>
              {applyErr && <span className="small" style={{ color:'#b91c1c' }}>{applyErr}</span>}
            </div>
          )}
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
