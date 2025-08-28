import React from 'react';
import { Button } from '../../ui';

export function SaveBar({ onSave, onDelete, disabled, scenarioId }: { onSave?: () => void; onDelete?: () => void; disabled?: boolean; scenarioId?: string }) {
  return (
    <div className="sticky bottom-0 z-10 bg-[color:var(--panel)]/95 backdrop-blur border-t border-[color:var(--border)] px-3 py-2 flex items-center justify-between">
      <div className="text-xs text-[color:var(--muted)]">{scenarioId ? `Scenario: ${scenarioId}` : 'New scenario'}</div>
      <div className="flex gap-2">
        {onDelete && (
          <Button size="sm" variant="danger" onClick={onDelete} disabled={disabled}>Delete</Button>
        )}
        {onSave && (
          <Button size="sm" variant="primary" onClick={onSave} disabled={disabled}>Save</Button>
        )}
      </div>
    </div>
  );
}
