import React, { useState, useEffect, useRef } from 'react';
import type { ScenarioConfiguration } from '$lib/types.js';

interface RawJsonEditorProps {
  config: ScenarioConfiguration;
  onChange: (config: ScenarioConfiguration) => void;
}

export function RawJsonEditor({ config, onChange }: RawJsonEditorProps) {
  const [jsonText, setJsonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Initialize text from config
  useEffect(() => {
    setJsonText(JSON.stringify(config, null, 2));
    setIsDirty(false);
    setError(null);
  }, [config]);

  // Auto-resize textarea on mount and when text changes
  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      textareaRef.current.style.height = textareaRef.current.scrollHeight + 'px';
    }
  }, [jsonText]);

  const handleTextChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setJsonText(e.target.value);
    setIsDirty(true);
    setError(null);
  };

  const handleSave = () => {
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

      onChange(parsed);
      setIsDirty(false);
      setError(null);
    } catch (e) {
      if (e instanceof SyntaxError) {
        setError(`JSON Syntax Error: ${e.message}`);
      } else if (e instanceof Error) {
        setError(e.message);
      } else {
        setError('Invalid JSON');
      }
    }
  };

  const handleCancel = () => {
    setJsonText(JSON.stringify(config, null, 2));
    setIsDirty(false);
    setError(null);
  };

  return (
    <div>
      <textarea
        ref={textareaRef}
        className="w-full font-mono text-xs border rounded-md p-3 bg-slate-50 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none overflow-hidden"
        value={jsonText}
        onChange={handleTextChange}
        placeholder="Enter valid scenario JSON..."
        spellCheck={false}
        style={{ 
          minHeight: '500px',
          height: 'auto',
          overflowY: 'hidden'
        }}
      />
      
      {error && (
        <div className="mt-2 p-2 text-sm text-red-700 bg-red-50 border border-red-200 rounded">
          {error}
        </div>
      )}

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
    </div>
  );
}