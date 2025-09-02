import React from 'react';
import { Card, Button } from '../../ui';
import { Trash2 } from 'lucide-react';
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
  isEditMode,
  onDelete,
  onRestore,
  isLocked,
  isDeleted,
  onSave,
  onDiscard,
  canSave,
  isSaving,
  saveLabel,
  configRevision
}: {
  config: any;
  viewMode: 'structured' | 'rawJson';
  onViewModeChange: (m: 'structured' | 'rawJson') => void;
  onConfigChange: (c: any) => void;
  scenarioName: string;
  scenarioId?: string;
  isViewMode?: boolean;
  isEditMode?: boolean;
  onDelete?: () => void;
  onRestore?: () => void;
  isLocked?: boolean;
  isDeleted?: boolean;
  onSave?: () => void;
  onDiscard?: () => void;
  canSave?: boolean;
  isSaving?: boolean;
  saveLabel?: string;
  configRevision?: number;
}) {
  const navigate = useNavigate();
  
  return (
    <Card>
      <div className="sticky top-0 z-10 bg-panel/95 backdrop-blur border-b border-border p-2 lg:p-3 flex items-center justify-between">
        <div className="flex gap-1 p-0.5 bg-slate-100 rounded">
          <button className={`px-3 py-1 text-xs rounded transition ${viewMode === 'structured' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`} onClick={() => onViewModeChange('structured')}>Structured View</button>
          <button className={`px-3 py-1 text-xs rounded transition ${viewMode === 'rawJson' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600 hover:text-slate-900'}`} onClick={() => onViewModeChange('rawJson')}>Raw JSON</button>
        </div>
        <div className="flex gap-2">
          {isEditMode && (
            <>
              {onSave && (
                <Button size="sm" variant="primary" onClick={onSave} disabled={isLocked || !canSave || isSaving}>
                  {isSaving ? 'Saving…' : (saveLabel || 'Save')}
                </Button>
              )}
              {onDiscard && (
                <Button size="sm" variant="secondary" onClick={onDiscard} disabled={isLocked || !canSave}>
                  Discard
                </Button>
              )}
            </>
          )}
          {scenarioId && (
            isEditMode ? (
              <>
                <Button as="a" href={`#/scenarios/${scenarioId}`} size="sm" variant="secondary">View</Button>
                {isDeleted ? (
                  onRestore && <Button size="sm" variant="primary" onClick={onRestore} disabled={isLocked}>Restore</Button>
                ) : (
                  onDelete && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-danger"
                      onClick={onDelete}
                      disabled={isLocked}
                      aria-label="Delete scenario"
                      title="Delete scenario"
                    >
                      <Trash2 size={16} />
                    </Button>
                  )
                )}
              </>
            ) : (
              <>
                <Button as="a" href={`#/scenarios/${scenarioId}/edit`} size="sm" variant="secondary">Edit</Button>
                <Button as="a" size="sm" href={`#/scenarios/${scenarioId}/run`}>
                  Run
                </Button>
              </>
            )
          )}
        </div>
      </div>
      <div className="p-3 lg:p-4">
        {viewMode === 'structured' ? (
          <StructuredView config={config} onConfigChange={onConfigChange} isReadOnly={isViewMode} scenarioId={scenarioId} isEditMode={isEditMode} />
        ) : (
          <RawJsonEditor config={config} onChange={onConfigChange} isReadOnly={isViewMode} revision={configRevision} />
        )}
      </div>
    </Card>
  );
}
