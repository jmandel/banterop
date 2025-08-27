import React from 'react';
import { useAppStore } from '../state/store';

export function PlannerSelector() {
  const pid = useAppStore(s => s.plannerId);
  const setPlanner = useAppStore(s => s.setPlanner);
  return (
    <div className="row" style={{ gap: 6, alignItems:'center' }}>
      <span className="small muted">Planner:</span>
      <select value={pid} onChange={e => setPlanner(e.target.value as any)}>
        <option value="off">Off</option>
        <option value="llm-drafter">LLM Drafter</option>
        <option value="scenario-v0.3">Scenario Planner</option>
      </select>
    </div>
  );
}

export function PlannerModeSelector() {
  const mode = useAppStore(s => s.plannerMode);
  const setMode = useAppStore(s => s.setPlannerMode);
  return (
    <div className="row" style={{ gap: 6, alignItems:'center' }}>
      <span className="small muted">Mode:</span>
      <select value={mode} onChange={e => setMode(e.target.value as any)} title="Planner approval mode">
        <option value="approve">Approve each turn</option>
        <option value="auto">Auto-approve</option>
      </select>
    </div>
  );
}

