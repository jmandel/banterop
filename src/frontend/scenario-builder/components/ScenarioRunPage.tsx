import React, { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import type { ScenarioItem, ScenarioConfiguration, CreateConversationRequest, AgentConfig } from '$lib/types.js';
import { encodeConfigToBase64URL } from '$lib/utils/config-encoding.js';
import { validateCreateConversationConfigV2 } from '$lib/utils/config-validation.js';
import { api } from '../utils/api.js';

export function ScenarioRunPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const navigate = useNavigate();
  const [searchParams] = React.useState(() => new URLSearchParams(window.location.hash.split('?')[1] || ''));
  const isPluginMode = searchParams.get('mode') === 'plugin';
  
  const [scenario, setScenario] = useState<ScenarioItem | null>(null);
  const [config, setConfig] = useState<CreateConversationRequest | null>(null);
  const [runMode, setRunMode] = useState<'internal' | 'plugin'>(isPluginMode ? 'plugin' : 'internal');
  const [selectedPluginRole, setSelectedPluginRole] = useState<string>('');
  const [conversationInitiator, setConversationInitiator] = useState<string>('');
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
        
        // Set default initiator to the first agent if not already set
        const agentsList = configData.agents || [];
        if (agentsList.length > 0 && !conversationInitiator) {
          setConversationInitiator(agentsList[0].agentId);
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

    // Build agent configs from scenario - use actual agent IDs from the scenario
    const agents: AgentConfig[] = [];
    
    // Get the actual agent IDs from the scenario config
    const scenarioAgents = scenario.config.agents || [];
    
    if (scenarioAgents.length < 2) {
      console.error('Scenario must have at least 2 agents defined', scenario);
      return;
    }
    
    const isPlugin = runMode === 'plugin' && selectedPluginRole;
    
    // Use the database scenario ID consistently (which should be the metadata.id when available)
    const scenarioId = scenario.config.metadata.id;
    
    // Map over the actual agents defined in the scenario
    scenarioAgents.forEach((scenarioAgent) => {
      const agentId = scenarioAgent.agentId;
      
      // Determine if this agent should be bridged or scenario-driven
      const isBridgedAgent = isPlugin && selectedPluginRole === agentId;
      
      const agentConfig: AgentConfig = {
        id: agentId, // Use the actual agent ID from the scenario
        strategyType: isBridgedAgent ? 'bridge_to_external_mcp_server' : 'scenario_driven',
        shouldInitiateConversation: isPlugin ? isBridgedAgent : (conversationInitiator === agentId),
        scenarioId: scenarioId, // Use consistent scenario ID
        additionalInstructions: additionalInstructions[agentId]
      };
      agents.push(agentConfig);
    });

    // Build the configuration
    const newConfig: CreateConversationRequest = {
      metadata: {
        scenarioId: scenarioId, // Use same scenario ID
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
    <div className="max-w-4xl mx-auto p-6">
      <div className="mb-6">
        <h1 className="text-3xl font-bold text-gray-900 mb-2">{scenario.config.metadata?.title || scenario.name}</h1>
        <p className="text-gray-600">{scenario.config.metadata?.description || ''}</p>
      </div>

      <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
        {/* Configuration Panel */}
        <div className="space-y-6">
          <h2 className="text-xl font-semibold text-gray-900">Configuration</h2>
          
          {/* Mode Selection */}
          <div className="grid grid-cols-2 gap-4">
            <div 
              className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                runMode === 'internal' 
                  ? 'border-blue-600 bg-blue-50' 
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
              onClick={() => { setRunMode('internal'); setSelectedPluginRole(''); }}
            >
              <div className="font-semibold text-gray-900 mb-1">Run Internally</div>
              <div className="text-sm text-gray-600">Simulate conversation with AI agents</div>
            </div>
            <div 
              className={`p-4 rounded-lg border-2 cursor-pointer transition-all ${
                runMode === 'plugin' 
                  ? 'border-blue-600 bg-blue-50' 
                  : 'border-gray-200 hover:border-gray-300 bg-white'
              }`}
              onClick={() => setRunMode('plugin')}
            >
              <div className="font-semibold text-gray-900 mb-1">Plug In</div>
              <div className="text-sm text-gray-600">Connect external MCP client</div>
            </div>
          </div>
            
          {/* Conversation Title */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Conversation Title
            </label>
            <input
              type="text"
              value={conversationTitle}
              onChange={(e) => setConversationTitle(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="Enter a title for this conversation"
            />
          </div>
          
          {/* Conversation Description */}
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Conversation Description
            </label>
            <textarea
              value={conversationDescription}
              onChange={(e) => setConversationDescription(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              placeholder="Enter a description for this conversation"
              rows={2}
            />
          </div>

          {/* Plugin Role Selection - Only show in plugin mode */}
          {runMode === 'plugin' && scenario && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                External Plugin Role
              </label>
              <select
                value={selectedPluginRole}
                onChange={(e) => setSelectedPluginRole(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                <option value="">Select a role...</option>
                {(scenario.config.agents || []).map((agent) => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.agentId} {agent.principal?.name ? `(${agent.principal.name})` : ''} - External MCP Client
                  </option>
                ))}
              </select>
              <p className="mt-1 text-sm text-gray-600">
                Select which role should be controlled by an external MCP client
              </p>
            </div>
          )}
          
          {/* Conversation Initiator - Only show in internal mode */}
          {runMode === 'internal' && scenario && (
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">
                Conversation Initiator
              </label>
              <select
                value={conversationInitiator}
                onChange={(e) => setConversationInitiator(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              >
                {(scenario.config.agents || []).map((agent) => (
                  <option key={agent.agentId} value={agent.agentId}>
                    {agent.agentId} {agent.principal?.name ? `(${agent.principal.name})` : ''}
                  </option>
                ))}
              </select>
              <p className="mt-1 text-sm text-gray-600">
                Select which agent should start the conversation
              </p>
            </div>
          )}

          {/* Additional Instructions */}
          {scenario && (
            <div>
              <h3 className="text-lg font-semibold text-gray-900 mb-4">Additional Instructions (optional)</h3>
              
              <div className="space-y-4">
                {(scenario.config.agents || []).map((agent) => (
                  <div key={agent.agentId}>
                    <label className="block text-sm font-medium text-gray-600 mb-1">
                      {agent.agentId} {agent.principal?.name ? `(${agent.principal.name})` : ''}
                    </label>
                    <textarea
                      value={additionalInstructions[agent.agentId] || ''}
                      onChange={(e) => setAdditionalInstructions({
                        ...additionalInstructions,
                        [agent.agentId]: e.target.value
                      })}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-700"
                      placeholder={`Additional instructions for ${agent.agentId}...`}
                      rows={2}
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Validation Messages */}
          {validationErrors.length > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-lg p-4">
              <h4 className="font-medium text-red-900 mb-2">Validation Errors:</h4>
              <ul className="list-disc list-inside text-sm text-red-700 space-y-1">
                {validationErrors.map((error, i) => (
                  <li key={i}>{error}</li>
                ))}
              </ul>
            </div>
          )}

          {validationWarnings.length > 0 && (
            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <h4 className="font-medium text-yellow-900 mb-2">Warnings:</h4>
              <ul className="list-disc list-inside text-sm text-yellow-700 space-y-1">
                {validationWarnings.map((warning, i) => (
                  <li key={i}>{warning}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Action Buttons */}
          <div className="pt-4">
            {runMode === 'internal' && (
              <button
                onClick={handleConfigureScenario}
                disabled={validationErrors.length > 0}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                Continue to Run Configuration
              </button>
            )}

            {runMode === 'plugin' && selectedPluginRole && (
              <button
                onClick={handleConfigureScenario}
                disabled={validationErrors.length > 0}
                className="w-full px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-300 disabled:cursor-not-allowed transition-colors"
              >
                Continue to Plugin Configuration
              </button>
            )}
            
            {runMode === 'plugin' && !selectedPluginRole && (
              <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
                <p className="text-sm text-yellow-700">Please select a role for the external plugin</p>
              </div>
            )}
          </div>
        </div>

      </div>
    </div>
  );
}