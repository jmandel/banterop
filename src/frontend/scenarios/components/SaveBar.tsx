import React from 'react';

export function SaveBar({ onSave, onDelete, disabled, scenarioId }: { onSave?: () => void; onDelete?: () => void; disabled?: boolean; scenarioId?: string }) {
  return (
    <div className="sticky bottom-0 z-10 bg-white/95 backdrop-blur border-t px-3 py-2 flex items-center justify-between">
      <div className="text-xs text-slate-500">{scenarioId ? `Scenario: ${scenarioId}` : 'New scenario'}</div>
      <div className="flex gap-2">
        {onDelete && (
          <button className="px-3 py-1 text-xs bg-rose-600 text-white rounded hover:bg-rose-700" onClick={onDelete} disabled={disabled}>Delete</button>
        )}
        {onSave && (
          <button className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700" onClick={onSave} disabled={disabled}>Save</button>
        )}
      </div>
    </div>
  );
}

