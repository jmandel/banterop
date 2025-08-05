import React from 'react';
import type { ScenarioConfiguration } from '$lib/types.js';
import { StructuredView } from './StructuredView.js';
import { RawJsonEditor } from './RawJsonEditor.js';

interface ScenarioEditorProps {
  config: ScenarioConfiguration;
  viewMode: 'structured' | 'rawJson';
  onViewModeChange: (mode: 'structured' | 'rawJson') => void;
  onConfigChange: (config: ScenarioConfiguration) => void;
  scenarioName: string;
  scenarioId?: string;
  isViewMode?: boolean;
}

export function ScenarioEditor({
  config,
  viewMode,
  onViewModeChange,
  onConfigChange,
  scenarioName,
  scenarioId,
  isViewMode
}: ScenarioEditorProps) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b p-2 lg:p-3 flex items-center justify-between">
        <div className="flex gap-1 p-0.5 bg-slate-100 rounded">
          <button
            className={`px-3 py-1 text-xs rounded transition ${
              viewMode === 'structured' 
                ? 'bg-white text-slate-900 shadow-sm' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
            onClick={() => onViewModeChange('structured')}
          >
            Structured View
          </button>
          <button
            className={`px-3 py-1 text-xs rounded transition ${
              viewMode === 'rawJson' 
                ? 'bg-white text-slate-900 shadow-sm' 
                : 'text-slate-600 hover:text-slate-900'
            }`}
            onClick={() => onViewModeChange('rawJson')}
          >
            Raw JSON
          </button>
        </div>
      </div>

      <div className="p-3 lg:p-4">
        {viewMode === 'structured' ? (
          <StructuredView config={config} />
        ) : (
          <RawJsonEditor config={config} onChange={onConfigChange} />
        )}
      </div>
    </div>
  );
}