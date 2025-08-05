import React, { useState, useEffect, useRef, useMemo } from 'react';
import type { ScenarioConfiguration } from '$lib/types.js';

interface RawJsonEditorProps {
  config: ScenarioConfiguration;
  onChange: (config: ScenarioConfiguration) => void;
  isReadOnly?: boolean;
}

export function RawJsonEditor({ config, onChange, isReadOnly = false }: RawJsonEditorProps) {
  // Convert config to JSON string
  const propJson = useMemo(() => JSON.stringify(config, null, 2), [config]);
  
  // Local state
  const [jsonText, setJsonText] = useState(propJson);
  const [lastAppliedJson, setLastAppliedJson] = useState(propJson);
  const [error, setError] = useState<string | null>(null);
  const [isEditing, setIsEditing] = useState(false);
  const [hasExternalUpdate, setHasExternalUpdate] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  
  // Auto-resize on mount
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, []); // Only on mount

  // Sync from props when not editing
  useEffect(() => {
    // Don't sync while saving - we handle that in the save handler
    if (isSaving) return;
    
    if (!isEditing && propJson !== lastAppliedJson) {
      // User is not editing, apply external changes immediately
      setJsonText(propJson);
      setLastAppliedJson(propJson);
      setError(null);
      setHasExternalUpdate(false);
      // Auto-resize when content changes from external source
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
      }
    } else if (isEditing && propJson !== lastAppliedJson) {
      // External change arrived while user is editing
      setHasExternalUpdate(true);
    }
  }, [propJson, isEditing, lastAppliedJson, isSaving]);


  const isDirty = jsonText !== lastAppliedJson;

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setJsonText(e.target.value);
    setError(null);
  };

  const handleSave = () => {
    setIsSaving(true);
    try {
      const parsed = JSON.parse(jsonText);
      
      // Basic validation
      if (!parsed.metadata || !parsed.scenario || !parsed.agents) {
        throw new Error('Invalid scenario structure. Missing required top-level fields (metadata, scenario, agents).');
      }

      // Validate it's an array of agents
      if (!Array.isArray(parsed.agents)) {
        throw new Error('agents must be an array');
      }

      // Validate each agent has required fields
      for (const agent of parsed.agents) {
        if (!agent.agentId || !agent.principal || !agent.systemPrompt) {
          throw new Error('Each agent must have agentId, principal, and systemPrompt');
        }
      }

      console.log('[RawJsonEditor] Calling onChange with parsed config');
      onChange(parsed);
      
      // Update our tracking of what's been saved
      const normalized = JSON.stringify(parsed, null, 2);
      setLastAppliedJson(normalized);
      setJsonText(normalized); // Normalize the display
      setError(null);
      setHasExternalUpdate(false);
      
      // Auto-resize after save
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
      }
      console.log('[RawJsonEditor] Save completed, isDirty should be false now');
    } catch (e) {
      if (e instanceof SyntaxError) {
        setError(`JSON Syntax Error: ${e.message}`);
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError('Invalid JSON');
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setJsonText(lastAppliedJson);
    setError(null);
    setHasExternalUpdate(false);
  };

  const handleRefreshFromExternal = () => {
    setJsonText(propJson);
    setLastAppliedJson(propJson);
    setHasExternalUpdate(false);
    setError(null);
    
    // Auto-resize after refresh
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  };

  return (
    <div>
      <textarea
        ref={textareaRef}
        className={`w-full font-mono text-xs border rounded-md p-3 resize-none ${
          isReadOnly 
            ? 'bg-gray-50 cursor-default' 
            : 'bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500'
        }`}
        value={jsonText}
        onChange={handleTextChange}
        onFocus={() => setIsEditing(true)}
        onBlur={() => setIsEditing(false)}
        placeholder="Enter valid scenario JSON..."
        spellCheck={false}
        readOnly={isReadOnly}
        style={{ 
          minHeight: '400px',
          maxHeight: 'calc(70vh - 180px)', // Leave room for header, buttons and messages
          overflowY: 'auto'
        }}
      />
      
      {error && (
        <div className="mt-2 p-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded">
          {error}
        </div>
      )}

      {hasExternalUpdate && isEditing && (
        <div className="mt-2 p-2 text-sm bg-yellow-50 border border-yellow-200 rounded flex items-center justify-between">
          <span>External changes were made to the scenario.</span>
          <button
            className="ml-2 px-2 py-1 text-xs bg-yellow-600 text-white rounded hover:bg-yellow-700"
            onClick={handleRefreshFromExternal}
          >
            Refresh from Scenario
          </button>
        </div>
      )}

      {!isReadOnly && (
        <div className="mt-3 flex justify-end gap-2">
          <button
            className="px-3 py-1.5 text-sm border border-gray-300 bg-white rounded hover:bg-gray-50 disabled:opacity-50"
            onClick={handleCancel}
            disabled={!isDirty}
          >
            Cancel
          </button>
          <button
            className="px-4 py-1.5 text-sm bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
            onClick={handleSave}
            disabled={!isDirty}
          >
            Save to Pending
          </button>
        </div>
      )}
    </div>
  );
}