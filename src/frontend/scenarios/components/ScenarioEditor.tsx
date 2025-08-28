import React from 'react';
import { Card, Button } from '../../ui';
import { RawJsonEditor } from './RawJsonEditor';
import { StructuredView } from './StructuredView';
import { DropdownButton } from './DropdownButton';
import { RUN_MODES } from '../constants/runModes';
import { useNavigate } from 'react-router-dom';

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
  const navigate = useNavigate();
  
  return (
    <Card>
      <div className="sticky top-0 z-10 bg-[color:var(--panel)]/95 backdrop-blur border-b border-[color:var(--border)] p-2 lg:p-3 flex items-center justify-between">
        <div className="flex gap-1 p-0.5 bg-slate-100 rounded">
          <button className={`px-3 py-1 text-xs rounded transition ${viewMode === 'structured' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`} onClick={() => onViewModeChange('structured')}>Structured View</button>
          <button className={`px-3 py-1 text-xs rounded transition ${viewMode === 'rawJson' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`} onClick={() => onViewModeChange('rawJson')}>Raw JSON</button>
        </div>
        {scenarioId && (
          <div className="flex gap-2">
            {isEditMode ? (
              <Button as="a" href={`#/scenarios/${scenarioId}`} size="sm" variant="secondary">View</Button>
            ) : (
              <>
                <Button as="a" href={`#/scenarios/${scenarioId}/edit`} size="sm" variant="secondary">Edit</Button>
                <Button size="sm" onClick={() => navigate(`/scenarios/${scenarioId}/run`)}>
                  Run
                </Button>
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
    </Card>
  );
}
