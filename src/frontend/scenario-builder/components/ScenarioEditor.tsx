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
}

export function ScenarioEditor({
  config,
  viewMode,
  onViewModeChange,
  onConfigChange,
  scenarioName
}: ScenarioEditorProps) {
  return (
    <div className="editor-panel">
      <div className="editor-header">
        <h2 style={{ fontSize: '20px', fontWeight: 600, color: '#1a1a1a' }}>
          {scenarioName}
        </h2>
        <div className="view-toggle">
          <button
            className={`toggle-btn ${viewMode === 'structured' ? 'active' : ''}`}
            onClick={() => onViewModeChange('structured')}
          >
            Structured View
          </button>
          <button
            className={`toggle-btn ${viewMode === 'rawJson' ? 'active' : ''}`}
            onClick={() => onViewModeChange('rawJson')}
          >
            Raw JSON
          </button>
        </div>
      </div>

      {viewMode === 'structured' ? (
        <StructuredView config={config} />
      ) : (
        <RawJsonEditor config={config} onChange={onConfigChange} />
      )}
    </div>
  );
}