import React, { useState, useEffect } from 'react';
import type { ScenarioConfiguration } from '$lib/types.js';

interface RawJsonEditorProps {
  config: ScenarioConfiguration;
  onChange: (config: ScenarioConfiguration) => void;
}

export function RawJsonEditor({ config, onChange }: RawJsonEditorProps) {
  const [jsonText, setJsonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

  // Initialize text from config
  useEffect(() => {
    setJsonText(JSON.stringify(config, null, 2));
    setIsDirty(false);
    setError(null);
  }, [config]);

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
    <div className="json-editor">
      <textarea
        className="json-textarea"
        value={jsonText}
        onChange={handleTextChange}
        placeholder="Enter valid scenario JSON..."
        spellCheck={false}
      />
      
      {error && (
        <div style={{
          marginTop: '8px',
          padding: '8px 12px',
          backgroundColor: '#fee',
          border: '1px solid #fcc',
          borderRadius: '4px',
          color: '#c00',
          fontSize: '14px'
        }}>
          {error}
        </div>
      )}

      <div className="json-editor-actions">
        <button
          className="btn-secondary"
          onClick={handleCancel}
          disabled={!isDirty}
        >
          Cancel
        </button>
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={!isDirty}
          style={{ padding: '8px 16px' }}
        >
          Save to Pending
        </button>
      </div>
    </div>
  );
}