import React from 'react';
import { useAppStore } from '../state/store';
import { statusLabel } from './status-labels';

export function TaskRibbon() {
  const taskId = useAppStore(s => s.taskId);
  const uiStatus = useAppStore(s => s.uiStatus());
  function statusBadgeText(s: string): string { return statusLabel(s); }
  return (
    <div className="card compact">
      <div className="row compact" style={{ alignItems:'center' }}>
        <strong>Task</strong>
        <span className="pill">ID: {taskId || '—'}</span>
        <span className="pill">Status: {statusBadgeText(uiStatus)}</span>
      </div>
    </div>
  );
}
