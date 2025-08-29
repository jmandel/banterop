import React from 'react';
import { Switch } from './Switch';

export function AutomationCard({ mode, onModeChange, plannerSelect }:{
  mode: 'approve'|'auto';
  onModeChange: (m:'approve'|'auto') => void;
  plannerSelect: React.ReactNode;
}) {
  return (
    <div className="card">
      <div className="small font-semibold mb-2">Automation</div>
      <div className="row items-center mb-2">
        <div className="small flex-1">Require review before sending</div>
        <Switch checked={mode==='approve'} onChange={(v)=>onModeChange(v ? 'approve' : 'auto')} />
      </div>
      <div>
        {plannerSelect}
      </div>
    </div>
  );
}

