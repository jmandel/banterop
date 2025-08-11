import React from 'react';
import { RawJsonEditor } from './RawJsonEditor';
import { StructuredView } from './StructuredView';

export function ScenarioEditor({
  config,
  viewMode,
  onViewModeChange,
  onConfigChange,
  scenarioName,
  scenarioId,
  isViewMode,
  isEditMode
}: {
  config: any;
  viewMode: 'structured' | 'rawJson';
  onViewModeChange: (m: 'structured' | 'rawJson') => void;
  onConfigChange: (c: any) => void;
  scenarioName: string;
  scenarioId?: string;
  isViewMode?: boolean;
  isEditMode?: boolean;
}) {
  return (
    <div className="rounded-md border border-slate-200 bg-white">
      <div className="sticky top-0 z-10 bg-white/95 backdrop-blur border-b p-2 lg:p-3 flex items-center justify-between">
        <div className="flex gap-1 p-0.5 bg-slate-100 rounded">
          <button className={`px-3 py-1 text-xs rounded transition ${viewMode === 'structured' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`} onClick={() => onViewModeChange('structured')}>Structured View</button>
          <button className={`px-3 py-1 text-xs rounded transition ${viewMode === 'rawJson' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`} onClick={() => onViewModeChange('rawJson')}>Raw JSON</button>
        </div>
        {scenarioId && (
          <div className="flex gap-2">
            {isEditMode ? (
              <a href={`#/scenarios/${scenarioId}`} className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">View</a>
            ) : (
              <>
                <a href={`#/scenarios/${scenarioId}/edit`} className="px-3 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50">Edit</a>
                <a href={`#/scenarios/${scenarioId}/run`} className="px-3 py-1 text-xs bg-blue-600 text-white rounded hover:bg-blue-700">Run</a>
                <a href={`#/scenarios/${scenarioId}/run?mode=plugin`} className="px-3 py-1 text-xs bg-purple-600 text-white rounded hover:bg-purple-700">Plug In</a>
              </>
            )}
          </div>
        )}
      </div>
      <div className="p-3 lg:p-4">
        {viewMode === 'structured' ? (
          <StructuredView config={config} onConfigChange={onConfigChange} isReadOnly={isViewMode} scenarioId={scenarioId} isEditMode={isEditMode} />
        ) : (
          <RawJsonEditor config={config} onChange={onConfigChange} isReadOnly={isViewMode} />
        )}
      </div>
    </div>
  );
}

