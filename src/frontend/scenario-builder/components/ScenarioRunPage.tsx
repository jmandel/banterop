import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { ScenarioConfiguration, CreateConversationRequest, AgentConfig } from '$lib/types.js';
import { encodeConfigToBase64URL } from '$lib/utils/config-encoding.js';
import { validateCreateConversationConfigV2 } from '$lib/utils/config-validation.js';
import { api } from '../utils/api.js';

export function ScenarioRunPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const navigate = useNavigate();
  const [searchParams] = React.useState(() => new URLSearchParams(window.location.hash.split('?')[1] || ''));
  const isPluginMode = searchParams.get('mode') === 'plugin';
  
  const [scenario, setScenario] = useState<ScenarioConfiguration | null>(null);
  const [config, setConfig] = useState<CreateConversationRequest | null>(null);
  const [runMode, setRunMode] = useState<'internal' | 'plugin'>(isPluginMode ? 'plugin' : 'internal');
  const [selectedPluginRole, setSelectedPluginRole] = useState<string>('');
  const [conversationInitiator, setConversationInitiator] = useState<string>('patient');
  const [additionalInstructions, setAdditionalInstructions] = useState<Record<string, string>>({});
  const [conversationTitle, setConversationTitle] = useState('');
  const [conversationDescription, setConversationDescription] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const [validationWarnings, setValidationWarnings] = useState<string[]>([]);

  // Load scenario on mount
  useEffect(() => {
    if (scenarioId) {
      loadScenario(scenarioId);
    }
  }, [scenarioId]);

  // Update config when inputs change
  useEffect(() => {
    if (scenario) {
      buildConfig();
    }
  }, [scenario, runMode, selectedPluginRole, conversationInitiator, additionalInstructions, conversationTitle, conversationDescription]);

  const loadScenario = async (id: string) => {
    setIsLoading(true);
    setError(null);
    
    try {
      const response = await api.getScenario(id);
      if (response.success && response.data) {
        const scenarioData = response.data;
        setScenario(scenarioData);
        
        // Check if response.data is the scenario config directly or wrapped
        const configData = scenarioData.config || scenarioData;
        const title = configData.metadata?.title || scenarioData.name || '';
        
        // Set a default title based on the mode
        if (title) {
          setConversationTitle(`${title} - ${isPluginMode ? 'MCP Plugin' : 'Test Run'}`);
        } else {
          setConversationTitle(isPluginMode ? 'MCP Plugin Session' : 'Test Conversation');
        }
      } else {
        setError('Failed to load scenario');
      }
    } catch (err) {
      setError('Error loading scenario: ' + (err instanceof Error ? err.message : 'Unknown error'));
    } finally {
      setIsLoading(false);
    }
  };

  const buildConfig = () => {
    if (!scenario) return;

    // Build agent configs from scenario
    const agents: AgentConfig[] = [];
    
    // Add patient agent
    const isPlugin = runMode === 'plugin' && selectedPluginRole;
    
    const patientConfig: AgentConfig = {
      id: 'patient',
      strategyType: (isPlugin && selectedPluginRole === 'patient') ? 'bridge_to_external_mcp_server' : 'scenario_driven',
      shouldInitiateConversation: isPlugin ? (selectedPluginRole === 'patient') : (conversationInitiator === 'patient'),
      scenarioId: scenario.id,
      additionalInstructions: additionalInstructions['patient']
    };
    agents.push(patientConfig);

    // Add supplier agent
    const supplierConfig: AgentConfig = {
      id: 'supplier',
      strategyType: (isPlugin && selectedPluginRole === 'supplier') ? 'bridge_to_external_mcp_server' : 'scenario_driven',
      shouldInitiateConversation: isPlugin ? (selectedPluginRole === 'supplier') : (conversationInitiator === 'supplier'),
      scenarioId: scenario.id,
      additionalInstructions: additionalInstructions['supplier']
    };
    agents.push(supplierConfig);

    // Build the configuration
    const newConfig: CreateConversationRequest = {
      metadata: {
        scenarioId: scenario.id,
        conversationTitle,
        conversationDescription: conversationDescription || (runMode === 'plugin' ? `MCP bridge with ${selectedPluginRole || 'external client'}` : 'Internal agent simulation')
      },
      agents
    };

    setConfig(newConfig);

    // Validate the configuration
    const validation = validateCreateConversationConfigV2(newConfig);
    setValidationErrors(validation.errors);
    setValidationWarnings(validation.warnings);
  };

  const handleConfigureScenario = () => {
    if (!config || validationErrors.length > 0) return;
    
    const config64 = encodeConfigToBase64URL(config);
    navigate(`/scenarios/configured/${config64}`);
  };


  if (isLoading) {
    return <div className="p-8">Loading scenario...</div>;
  }

  if (error) {
    return <div className="p-8 text-red-600">Error: {error}</div>;
  }

  if (!scenario) {
    return <div className="p-8">Scenario not found</div>;
  }

  return (
    <div className="run-container">
      <div className="run-header">
        <h1 className="run-title">{scenario.metadata?.title || scenario.title || scenario.name}</h1>
        <p className="run-description">{scenario.metadata?.description || scenario.description || ''}</p>
      </div>

      <div className="run-content">
        {/* Configuration Panel */}
        <div className="config-panel">
          <h2 className="panel-title">Configuration</h2>
          
          {/* Mode Selection */}
          <div className="mode-selector">
            <div 
              className={`mode-option ${runMode === 'internal' ? 'selected' : ''}`}
              onClick={() => { setRunMode('internal'); setSelectedPluginRole(''); }}
            >
              <div className="mode-option-title">Run Internally</div>
              <div className="mode-option-desc">Simulate conversation with AI agents</div>
            </div>
            <div 
              className={`mode-option ${runMode === 'plugin' ? 'selected' : ''}`}
              onClick={() => setRunMode('plugin')}
            >
              <div className="mode-option-title">Plug In</div>
              <div className="mode-option-desc">Connect external MCP client</div>
            </div>
          </div>
            
          {/* Conversation Title */}
          <div className="form-group">
            <label className="form-label">
              Conversation Title
            </label>
            <input
              type="text"
              value={conversationTitle}
              onChange={(e) => setConversationTitle(e.target.value)}
              className="form-input"
              placeholder="Enter a title for this conversation"
            />
          </div>
          
          {/* Conversation Description */}
          <div className="form-group">
            <label className="form-label">
              Conversation Description
            </label>
            <textarea
              value={conversationDescription}
              onChange={(e) => setConversationDescription(e.target.value)}
              className="form-textarea"
              placeholder="Enter a description for this conversation"
              rows={2}
            />
          </div>

          {/* Plugin Role Selection - Only show in plugin mode */}
          {runMode === 'plugin' && (
            <div className="form-group">
              <label className="form-label">
                External Plugin Role
              </label>
              <select
                value={selectedPluginRole}
                onChange={(e) => setSelectedPluginRole(e.target.value)}
                className="form-select"
              >
                <option value="">Select a role...</option>
                <option value="patient">Patient (External MCP Client)</option>
                <option value="supplier">Supplier (External MCP Client)</option>
              </select>
              <p className="form-help">
                Select which role should be controlled by an external MCP client
              </p>
            </div>
          )}
          
          {/* Conversation Initiator - Only show in internal mode */}
          {runMode === 'internal' && (
            <div className="form-group">
              <label className="form-label">
                Conversation Initiator
              </label>
              <select
                value={conversationInitiator}
                onChange={(e) => setConversationInitiator(e.target.value)}
                className="form-select"
              >
                <option value="patient">Patient</option>
                <option value="supplier">Supplier</option>
              </select>
              <p className="form-help">
                Select which agent should start the conversation
              </p>
            </div>
          )}

          {/* Additional Instructions */}
          <div>
            <h3 className="form-label">Additional Instructions (optional)</h3>
            
            <div className="form-group">
              <label className="form-label">
                Patient Agent
              </label>
              <textarea
                value={additionalInstructions['patient'] || ''}
                onChange={(e) => setAdditionalInstructions({
                  ...additionalInstructions,
                  patient: e.target.value
                })}
                className="form-textarea"
                placeholder="Additional instructions for patient agent..."
              />
            </div>

            <div className="form-group">
              <label className="form-label">
                Supplier Agent
              </label>
              <textarea
                value={additionalInstructions['supplier'] || ''}
                onChange={(e) => setAdditionalInstructions({
                  ...additionalInstructions,
                  supplier: e.target.value
                })}
                className="form-textarea"
                placeholder="Additional instructions for supplier agent..."
              />
            </div>
          </div>

          {/* Validation Messages */}
          {validationErrors.length > 0 && (
            <div className="validation-message validation-errors">
              <h4 className="validation-title">Validation Errors:</h4>
              <ul className="validation-list">
                {validationErrors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            </div>
          )}

          {validationWarnings.length > 0 && (
            <div className="validation-message validation-warnings">
              <h4 className="validation-title">Warnings:</h4>
              <ul className="validation-list">
                {validationWarnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Action Buttons */}
          <div className="action-buttons">
            {runMode === 'internal' && (
              <button
                onClick={handleConfigureScenario}
                disabled={validationErrors.length > 0}
                className="btn-full btn-primary-full"
              >
                Continue to Run Configuration
              </button>
            )}

            {runMode === 'plugin' && selectedPluginRole && (
              <button
                onClick={handleConfigureScenario}
                disabled={validationErrors.length > 0}
                className="btn-full btn-primary-full"
              >
                Continue to Plugin Configuration
              </button>
            )}
            
            {runMode === 'plugin' && !selectedPluginRole && (
              <div className="validation-message validation-warnings">
                Please select a role for the external plugin
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}