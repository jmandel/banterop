import React from 'react';
import { ChevronUp, ChevronDown, Settings, RotateCcw } from 'lucide-react';
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
          for (let j = i + 1; j < facts.length; j++) { if (facts[j].type === 'message_sent') { sentAfter = true; break; } }
          if (!sentAfter) return true;
        }
      }
    }
    return false;
  }, [facts]);
  const canShowBegin = canBegin && !hud && !hasUnsentDraft && collapsed;
  const lastToolWhy = React.useMemo(() => {
    // Find most recent tool_call with a non-empty why/reasoning
    for (let i = facts.length - 1; i >= 0; --i) {
      const f: any = facts[i];
      if (f && f.type === 'tool_call') {
        const why = typeof f.why === 'string' && f.why.trim() ? f.why.trim() : (typeof f.reasoning === 'string' ? f.reasoning.trim() : '');
        if (why) return why;
      }
    }
    return '';
  }, [facts]);

  const lastToolResultWhy = React.useMemo(() => {
    for (let i = facts.length - 1; i >= 0; --i) {
      const f: any = facts[i];
      if (f && f.type === 'tool_result') {
        const w = typeof f.why === 'string' && f.why.trim() ? f.why.trim() : (typeof f.reasoning === 'string' ? f.reasoning.trim() : '');
        if (w) return w;
        break;
      }
    }
    return '';
  }, [facts]);

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
        {(() => {
          const { openSetup, collapseSetup } = useAppStore.getState();
          const disableToggle = !collapsed && !!row?.dirty; // can't collapse while dirty
          const onToggle = () => { if (disableToggle) return; collapsed ? openSetup() : collapseSetup(); };
          return (
            <div className="row" style={{ gap: 8, alignItems: 'center', alignSelf: 'flex-start' }}>
              <button
                className={`px-2 py-1 rounded text-sm border ${disableToggle ? 'opacity-60 cursor-not-allowed' : 'hover:bg-gray-100 hover:border-gray-200'} bg-transparent text-gray-700`}
                type="button"
                onClick={onToggle}
                aria-label={collapsed ? 'Expand configuration' : 'Collapse configuration'}
                aria-expanded={!collapsed}
                aria-controls={`planner-setup-panel-${pid}`}
                title={collapsed ? 'Configure' : (disableToggle ? 'Cannot collapse with unsaved changes' : 'Collapse')}
                disabled={disableToggle}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
              >
                <Settings size={16} strokeWidth={1.75} />
                <span>Configure</span>
                {collapsed ? <ChevronDown size={14} strokeWidth={1.75} /> : <ChevronUp size={14} strokeWidth={1.75} />}
              </button>
              {!collapsed && !!row?.dirty && (
                <button
                  className="px-2 py-1 rounded text-sm border hover:bg-gray-100 bg-transparent text-gray-700"
                  type="button"
                  onClick={() => {
                    // Reset draft to lastApplied and clear dirty
                    useAppStore.setState((s:any) => {
                      const cur = s.plannerSetup.byPlanner[pid] || {};
                      const last = cur.lastApplied || cur.draft || {};
                      return {
                        plannerSetup: {
                          ...s.plannerSetup,
                          byPlanner: {
                            ...s.plannerSetup.byPlanner,
                            [pid]: { ...cur, draft: last, dirty: false, errors: undefined }
                          }
                        }
                      };
                    });
                  }}
                  aria-label="Revert unsaved changes"
                  title="Revert unsaved changes"
                >
                  <span style={{ display:'inline-flex', alignItems:'center', gap:6 }}><RotateCcw size={14} strokeWidth={1.75} /> Reset</span>
                </button>
              )}
              {/* Save button next to Configure/Reset when panel is open */}
              {!collapsed && (!ready || !!row?.dirty) && (
                <button
                  className="px-3 py-1 rounded text-sm btn"
                  type="submit"
                  disabled={row?.pending || !(row?.valid) || (ready ? !(row?.dirty) : false)}
                  aria-label={ready ? 'Save changes' : 'Save & Apply'}
                  title={ready ? 'Save changes' : 'Save & Apply'}
                >
                  {ready ? 'Save Changes' : 'Save & Apply'}
                </button>
              )}
              {!collapsed && applyErr && <span className="small" style={{ color:'#b91c1c' }}>{applyErr}</span>}
            </div>
          );
        })()}
        <div className="row" style={{ gap: 8, alignItems: 'center', flex: 1 }}>
          {ready && (hud ? <span className="working-dot" aria-label="Working" title="Working" /> : <span className="idle-dot" aria-label="Ready" title="Ready" />)}
          {hud ? (
            <div className="text-xs text-gray-700 leading-snug break-words">
              <div className="row" style={{ gap:6, alignItems:'center' }}>
                {hud.phase && (() => {
                  const pc = hud.phase;
                  const color = pc === 'planning' ? 'info'
                    : pc === 'tool' ? 'warn'
                    : pc === 'drafting' ? 'ok'
                    : pc === 'reading' ? 'info'
                    : pc === 'waiting' ? 'warn'
                    : '';
                  const pulse = (pc === 'planning' || pc === 'tool') ? 'pulse' : '';
                  return <span className={`pill ${color} ${pulse}`}>{pc}</span>;
                })()}
                <div className="muted">{String(hud.title || '')}</div>
              </div>
              {typeof hud.body !== 'undefined' && (
                <pre className="code small whitespace-pre-wrap break-words max-w-full overflow-auto">{(() => { if (typeof hud.body === 'string') return hud.body; try { return JSON.stringify(hud.body, null, 2) } catch { return String(hud.body) } })()}</pre>
              )}
            </div>
          ) : (
            <div className="text-xs text-gray-700 leading-snug break-words">
              <div className="muted">{planner?.name ? `Idle — ${planner.name}` : 'Idle'}</div>
            </div>
          )}
        </div>
        {canShowBegin && <button className="btn" type="button" onClick={() => useAppStore.getState().kickoffConversationWithPlanner()}>Begin conversation</button>}
        {/* Save block moved next to Configure/Reset to keep controls together */}
      </div>
      {!collapsed && (
        <div style={{ marginTop: 10 }}>
          <SetupComp />
        </div>
      )}
    </form>
  );
}
