import React from 'react';

interface SaveBarProps {
  onSave: () => void;
  onDiscard: () => void;
  isSaving: boolean;
}

export function SaveBar({ onSave, onDiscard, isSaving }: SaveBarProps) {
  return (
    <div className="fixed bottom-0 left-0 right-0 bg-amber-50 border-t border-amber-200 p-3 flex justify-between items-center shadow-lg">
      <div className="text-sm text-amber-800">
        You have unsaved changes
      </div>
      <div className="flex gap-2">
        <button
          className="px-3 py-1.5 text-sm border border-gray-300 bg-white rounded hover:bg-gray-50 disabled:opacity-50"
          onClick={onDiscard}
          disabled={isSaving}
        >
          Discard Changes
        </button>
        <button
          className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
          onClick={onSave}
          disabled={isSaving}
        >
          {isSaving ? 'Saving...' : 'Save to Backend'}
        </button>
      </div>
    </div>
  );
}