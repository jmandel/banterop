import React from 'react';

interface SaveBarProps {
  onSave: () => void;
  onDiscard: () => void;
  isSaving: boolean;
}

export function SaveBar({ onSave, onDiscard, isSaving }: SaveBarProps) {
  return (
    <div className="save-bar">
      <div className="save-bar-message">
        You have unsaved changes
      </div>
      <div className="save-bar-actions">
        <button
          className="btn-secondary"
          onClick={onDiscard}
          disabled={isSaving}
        >
          Discard Changes
        </button>
        <button
          className="btn-primary"
          onClick={onSave}
          disabled={isSaving}
          style={{ padding: '8px 16px' }}
        >
          {isSaving ? 'Saving...' : 'Save to Backend'}
        </button>
      </div>
    </div>
  );
}