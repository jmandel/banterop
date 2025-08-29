import React from 'react';
import { useAppStore } from '../state/store';
import { statusLabel } from './status-labels';

export function TaskRibbon() {
  const taskId = useAppStore(s => s.taskId);
  const uiStatus = useAppStore(s => s.uiStatus());
  function statusBadgeText(s: string): string { return statusLabel(s); }
  function statusToneClass(s: string): string {
    switch (s) {
      case 'completed': return 'ok';
      case 'failed':
      case 'rejected': return 'danger';
      case 'canceled':
      case 'auth-required': return 'warn';
      case 'working': return 'info';
      case 'input-required': return 'warn'; // action required
      case 'submitted':
      case 'initializing':
      case 'unknown':
      default: return '';
    }
  }
  return (
    <div className="card compact">
      <div className="row compact" style={{ alignItems:'center' }}>
        <strong>Task</strong>
        <span className="pill">ID: {taskId || '—'}</span>
        <span className={`pill ${statusToneClass(uiStatus)}`}>Status: {statusBadgeText(uiStatus)}</span>
      </div>
    </div>
  );
}
