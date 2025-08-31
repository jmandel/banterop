import React from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { useAppStore } from '../state/store';
import { resolvePlanner } from '../planner/registry';

export function PlannerSetupCard() {
  const pid = useAppStore(s => s.plannerId);
  const planner = resolvePlanner(pid);
  const ready = useAppStore(s => !!s.readyByPlanner[pid]);
  const taskId = useAppStore(s => s.taskId);
  const role = useAppStore(s => s.role);
  const hud = useAppStore(s => s.hud);
  const setupUi = useAppStore(s => s.setupUi);
  const collapsed = setupUi.panel === 'collapsed';
  const row = useAppStore(s => s.plannerSetup.byPlanner[pid]);

  const [applyErr, setApplyErr] = React.useState<string | null>(null);

  // Auto open/collapse based on sufficiency: open when not ready; collapse when ready
  React.useEffect(() => {
    const s = useAppStore.getState();
    if (ready) {
      if (!collapsed) s.collapseSetup();
    } else {
      if (collapsed) s.openSetup();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pid, ready]);

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
          for (let j = i + 1; j < facts.length; j++) { if (facts[j].type === 'remote_sent') { sentAfter = true; break; } }
          if (!sentAfter) return true;
        }
      }
    }
    return false;
  }, [facts]);
  const canShowBegin = canBegin && (hud?.phase === 'idle' || !hud) && !hasUnsentDraft && collapsed;

  const saveApply = React.useCallback(async () => {
    setApplyErr(null);
    try {
      useAppStore.getState().applySetup(pid);
      useAppStore.getState().onApplyClicked();
    } catch (error: any) {
      setApplyErr(String(error?.message || 'Apply failed'));
    }
  }, [pid]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (row?.pending) return;
    saveApply();
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key !== 'Enter') return;
    const t = e.target as any;
    const tag = String((t?.tagName || '')).toUpperCase();
    const type = String(t?.type || '').toLowerCase();
    const isTextInput = tag === 'INPUT' && type === 'text';
    const isTextarea = tag === 'TEXTAREA';
    if (!isTextInput && !isTextarea) { e.preventDefault(); handleSubmit(e as any); }
  }

  const SetupComp = (planner as any)?.SetupComponent as (undefined | (() => React.ReactElement));

  // Note: planners that don't require config (e.g., llm-drafter) auto-apply defaults in their Setup component

  // If no SetupComponent, show a tiny message
  if (!SetupComp) {
    return (
      <div className="card" style={{ marginTop: 10 }}>
        <div className="small muted">This planner doesn't have a setup UI.</div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} onKeyDown={handleKeyDown} className="card" style={{ marginTop: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button
          className="p-1 rounded hover:bg-gray-100 text-gray-600 bg-transparent border-0"
          type="button"
          onClick={() => { const { openSetup, collapseSetup } = useAppStore.getState(); collapsed ? openSetup() : collapseSetup(); }}
          aria-label={collapsed ? 'Expand planner setup' : 'Collapse planner setup'}
          title={collapsed ? 'Expand' : 'Collapse'}
          style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}
        >
          {collapsed ? <ChevronDown size={16} strokeWidth={1.75} /> : <ChevronUp size={16} strokeWidth={1.75} />}
        </button>
        <div className="row" style={{ gap: 8, alignItems: 'center' }}>
          {ready && ((hud && hud.phase && hud.phase !== 'idle') ? <span className="working-dot" aria-label="Working" title="Working" /> : <span className="idle-dot" aria-label="Ready" title="Ready" />)}
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
            const compactArgs = (() => {
              if (!argsText) return '';
              try {
                const obj = JSON.parse(argsText);
                const keys = Object.keys(obj || {});
                const preview = keys.slice(0, 3).map(k => `${k}:${JSON.stringify(obj[k])}`).join(', ');
                return `(${preview}${keys.length > 3 ? ', …' : ''})`;
              } catch { return `(${argsText.length > 40 ? argsText.slice(0, 37) + '…' : argsText})`; }
            })();
            const pillText = isTool ? [name || 'tool', compactArgs].filter(Boolean).join(' ') : (raw || (phase === 'idle' ? (planner?.name ? `Idle — ${planner.name}` : 'Idle') : phase));
            return (<span className="pill" title={raw || undefined}>{pillText}</span>);
          })()}
        </div>
        {canShowBegin && <button className="btn" type="button" onClick={() => useAppStore.getState().kickoffConversationWithPlanner()}>Begin conversation</button>}
        {!collapsed && (!ready || (row?.dirty)) && (
          <div className="row" style={{ gap: 8, alignItems: 'center' }}>
            <button className="btn" type="submit" disabled={row?.pending || !(row?.valid) || (ready ? !(row?.dirty) : false)}>
              {ready ? 'Save Changes' : 'Save & Apply'}
            </button>
            {applyErr && <span className="small" style={{ color:'#b91c1c' }}>{applyErr}</span>}
          </div>
        )}
      </div>
      {!collapsed && (
        <div style={{ marginTop: 10 }}>
          <SetupComp />
        </div>
      )}
    </form>
  );
}
