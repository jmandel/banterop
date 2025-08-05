import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { applyPatch } from 'fast-json-patch';
import type { ScenarioConfiguration, ScenarioItem, JSONPatchOperation } from '$lib/types.js';
import { ChatPanel } from './ChatPanel.js';
import { ScenarioEditor } from './ScenarioEditor.js';
import { SaveBar } from './SaveBar.js';
import { api } from '../utils/api.js';
import { createDefaultScenario } from '../utils/defaults.js';
import { buildScenarioBuilderPrompt } from '../utils/prompt-builder.js';
import { parseBuilderLLMResponse } from '../utils/response-parser.js';
import { getCuratedSchemaText, getExampleScenarioText } from '../utils/schema-loader.js';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: {
    patches?: Array<{ op: string; path: string; value?: any; from?: string }>;
    replaceEntireScenario?: any;
  };
}

interface BuilderState {
  scenarios: ScenarioItem[];
  activeScenarioId: string | null;
  pendingConfig: ScenarioConfiguration | null;
  chatHistory: ChatMessage[];
  viewMode: 'structured' | 'rawJson';
  isLoading: boolean;
  error: string | null;
  isSaving: boolean;
  selectedModel: string;
  schemaText: string;
  examplesText: string;
  isWaitingForLLM: boolean;
  lastUserMessage: string;
  availableProviders: Array<{ name: string; models: string[] }>;
}

export function ScenarioBuilderPage() {
  const { scenarioId } = useParams<{ scenarioId?: string }>();
  const navigate = useNavigate();
  const isViewMode = window.location.hash.includes('/view');
  
  const [state, setState] = useState<BuilderState>({
    scenarios: [],
    activeScenarioId: null,
    pendingConfig: null,
    chatHistory: [],
    viewMode: 'structured',
    isLoading: true,
    error: null,
    isSaving: false,
    selectedModel: 'gemini-2.5-pro',
    schemaText: '',
    examplesText: '',
    isWaitingForLLM: false,
    lastUserMessage: '',
    availableProviders: []
  });
  
  // Store the abort controller outside of state
  const abortControllerRef = React.useRef<AbortController | null>(null);

  // Load scenarios and schema on mount
  useEffect(() => {
    loadScenarios();
    loadSchemaAndConfig();
  }, []);

  // Handle route changes
  useEffect(() => {
    if (scenarioId && scenarioId !== state.activeScenarioId) {
      selectScenario(scenarioId);
    } else if (!scenarioId && state.activeScenarioId) {
      // Clear selection when navigating to /scenarios
      setState(prev => ({
        ...prev,
        activeScenarioId: null,
        pendingConfig: null,
        chatHistory: []
      }));
    }
  }, [scenarioId]);

  const loadScenarios = async () => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    try {
      const response = await api.getScenarios();
      if (response.success) {
        setState(prev => ({
          ...prev,
          scenarios: response.data.scenarios,
          isLoading: false
        }));
      } else {
        throw new Error(response.error || 'Failed to load scenarios');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load scenarios'
      }));
    }
  };

  const loadSchemaAndConfig = async () => {
    try {
      // Load schema text synchronously (already loaded at build time)
      const schemaText = getCuratedSchemaText();
      const examplesText = getExampleScenarioText();
      
      // Load LLM config to get available models
      const llmConfig = await api.getLLMConfig();
      
      if (llmConfig.success && llmConfig.data?.providers) {
        // Find the first provider with a 'pro' model, otherwise use first model of first provider
        let defaultModel = 'gemini-2.5-pro';
        const providers = llmConfig.data.providers;
        
        // Try to find a 'pro' model
        for (const provider of providers) {
          const proModel = provider.models?.find((m: string) => m.includes('pro'));
          if (proModel) {
            defaultModel = proModel;
            break;
          }
        }
        
        // If no 'pro' model found, use first available model
        if (defaultModel === 'gemini-2.5-pro' && providers.length > 0 && providers[0].models?.length > 0) {
          defaultModel = providers[0].models[0];
        }
        
        setState(prev => ({
          ...prev,
          schemaText,
          examplesText,
          selectedModel: defaultModel,
          availableProviders: providers
        }));
      } else {
        // No providers available
        setState(prev => ({
          ...prev,
          schemaText,
          examplesText,
          availableProviders: []
        }));
      }
    } catch (error) {
      console.error('Failed to load LLM config:', error);
      // Continue with defaults even if this fails
      setState(prev => ({
        ...prev,
        schemaText: getCuratedSchemaText(),
        examplesText: getExampleScenarioText(),
        availableProviders: []
      }));
    }
  };

  const selectScenario = async (id: string) => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    try {
      const response = await api.getScenario(id);
      if (response.success) {
        const scenario = response.data;
        setState(prev => ({
          ...prev,
          activeScenarioId: id,
          chatHistory: scenario.history || [],
          pendingConfig: null,
          isLoading: false
        }));
      } else {
        throw new Error(response.error || 'Failed to load scenario');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        isLoading: false,
        error: error instanceof Error ? error.message : 'Failed to load scenario'
      }));
    }
  };

  const handleScenarioSelect = (id: string) => {
    navigate(`/scenarios/${id}/edit`);
  };

  const createNewScenario = async () => {
    const name = prompt('Enter scenario name:');
    if (!name) return;

    try {
      const config = createDefaultScenario();
      const response = await api.createScenario(name, config);
      if (response.success) {
        await loadScenarios();
        navigate(`/scenarios/${response.data.id}/edit`);
      } else {
        throw new Error(response.error || 'Failed to create scenario');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to create scenario'
      }));
    }
  };

  const deleteScenario = async (id: string) => {
    if (!confirm('Are you sure you want to delete this scenario?')) return;

    try {
      const response = await api.deleteScenario(id);
      if (response.success) {
        await loadScenarios();
        if (state.activeScenarioId === id) {
          setState(prev => ({
            ...prev,
            activeScenarioId: null,
            chatHistory: [],
            pendingConfig: null
          }));
        }
      } else {
        throw new Error(response.error || 'Failed to delete scenario');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to delete scenario'
      }));
    }
  };

  const sendMessage = async (userText: string) => {
    if (!state.activeScenarioId || state.isWaitingForLLM) return;

    const active = state.scenarios.find(s => s.id === state.activeScenarioId);
    if (!active) return;

    const currentScenario = state.pendingConfig || active.config;
    
    // Create new abort controller for this request
    const controller = new AbortController();
    abortControllerRef.current = controller;
    
    // Add user message to chat
    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: userText,
      timestamp: Date.now()
    };

    setState(prev => ({
      ...prev,
      chatHistory: [...prev.chatHistory, userMessage],
      isWaitingForLLM: true,
      lastUserMessage: userText
    }));

    try {
      // Ensure schema is loaded
      if (!state.schemaText) {
        await loadSchemaAndConfig();
      }
      
      // 1) Build prompt - include ALL conversation history up to this point
      // Since setState is async, we need to include the history manually
      const fullHistory = [...state.chatHistory]; // This already has all previous messages
      
      const prompt = buildScenarioBuilderPrompt({
        scenario: currentScenario,
        history: fullHistory.map(h => ({ 
          role: h.role, 
          content: h.content,
          toolCalls: h.toolCalls 
        })),
        userMessage: userText,
        schemaText: state.schemaText,
        examplesText: state.examplesText,
        modelCapabilitiesNote: '' // optional
      });
      
      // 2) Call LLM generate (server routing, no scenario-chat endpoint)
      let llmResponse;
      try {
        llmResponse = await api.generateLLM({
          messages: [{ role: 'user', content: prompt }],
          model: state.selectedModel,
          temperature: 0.2
        }, controller.signal);
      } catch (llmError: any) {
        // Check if it was aborted
        if (llmError.name === 'AbortError') {
          // Request was cancelled - remove the user message and reset
          setState(prev => ({
            ...prev,
            chatHistory: prev.chatHistory.slice(0, -1), // Remove last message
            isWaitingForLLM: false
          }));
          return;
        }
        
        // Add assistant error message to chat
        const errorMsg = {
          id: `msg_${Date.now() + 1}`,
          role: 'assistant' as const,
          content: `Error calling LLM: ${llmError instanceof Error ? llmError.message : 'Unknown error'}`,
          timestamp: Date.now()
        };
        setState(prev => ({
          ...prev,
          chatHistory: [...prev.chatHistory, errorMsg],
          isWaitingForLLM: false
        }));
        return;
      }
      
      // 3) Parse result
      let builderResult;
      try {
        builderResult = parseBuilderLLMResponse(llmResponse.data.content);
      } catch (e: any) {
        const errorMsg = {
          id: `msg_${Date.now() + 1}`,
          role: 'assistant' as const,
          content: `I produced an invalid result: ${e?.message || e}`,
          timestamp: Date.now()
        };
        setState(prev => ({
          ...prev,
          chatHistory: [...prev.chatHistory, errorMsg],
          isWaitingForLLM: false
        }));
        return;
      }
      
      // 4) Apply locally (patches preferred)
      let nextScenario = currentScenario;
      if (builderResult.patches && builderResult.patches.length > 0) {
        try {
          nextScenario = applyPatch(currentScenario, builderResult.patches).newDocument as typeof currentScenario;
        } catch (patchErr) {
          const errorMsg = {
            id: `msg_${Date.now() + 2}`,
            role: 'assistant' as const,
            content: `I attempted patches but they failed to apply: ${patchErr instanceof Error ? patchErr.message : 'Unknown error'}`,
            timestamp: Date.now()
          };
          setState(prev => ({
            ...prev,
            chatHistory: [...prev.chatHistory, errorMsg],
            isWaitingForLLM: false
          }));
          return;
        }
      } else if (builderResult.replaceEntireScenario) {
        // Minimal validation – ensure shape exists
        const repl = builderResult.replaceEntireScenario;
        if (!repl?.metadata || !repl?.scenario || !Array.isArray(repl?.agents)) {
          const errorMsg = {
            id: `msg_${Date.now() + 2}`,
            role: 'assistant' as const,
            content: 'Replacement scenario is missing required fields (metadata/scenario/agents).',
            timestamp: Date.now()
          };
          setState(prev => ({
            ...prev,
            chatHistory: [...prev.chatHistory, errorMsg],
            isWaitingForLLM: false
          }));
          return;
        }
        nextScenario = repl;
      }
      
      // 5) Append assistant message and set pending
      const assistantMsg: ChatMessage = {
        id: `msg_${Date.now() + 3}`,
        role: 'assistant' as const,
        content: builderResult.message,
        timestamp: Date.now(),
        toolCalls: {
          patches: builderResult.patches,
          replaceEntireScenario: builderResult.replaceEntireScenario
        }
      };
      
      setState(prev => ({
        ...prev,
        chatHistory: [...prev.chatHistory, assistantMsg],
        pendingConfig: nextScenario,
        isWaitingForLLM: false
      }));
    } catch (error) {
      const errorMsg: ChatMessage = {
        id: `msg_${Date.now() + 1}`,
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to process message'}`,
        timestamp: Date.now()
      };
      setState(prev => ({
        ...prev,
        chatHistory: [...prev.chatHistory, errorMsg],
        isWaitingForLLM: false
      }));
    } finally {
      // Clean up abort controller
      abortControllerRef.current = null;
    }
  };

  const stopGeneration = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
  };
  
  const saveChanges = async () => {
    if (!state.activeScenarioId || !state.pendingConfig) return;

    setState(prev => ({ ...prev, isSaving: true, error: null }));
    try {
      const response = await api.updateScenarioConfig(
        state.activeScenarioId,
        state.pendingConfig
      );

      if (response.success) {
        // Update local state
        setState(prev => ({
          ...prev,
          scenarios: prev.scenarios.map(s =>
            s.id === state.activeScenarioId
              ? { ...s, config: state.pendingConfig!, modified: Date.now() }
              : s
          ),
          pendingConfig: null,
          isSaving: false
        }));
      } else {
        throw new Error(response.error || 'Failed to save changes');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        isSaving: false,
        error: error instanceof Error ? error.message : 'Failed to save changes'
      }));
    }
  };

  const discardChanges = () => {
    setState(prev => ({ ...prev, pendingConfig: null }));
  };

  const updateConfigFromEditor = (newConfig: ScenarioConfiguration) => {
    setState(prev => ({ ...prev, pendingConfig: newConfig }));
  };

  const toggleViewMode = (mode: 'structured' | 'rawJson') => {
    setState(prev => ({ ...prev, viewMode: mode }));
  };

  const activeScenario = state.scenarios.find(s => s.id === state.activeScenarioId);
  const currentConfig = state.pendingConfig || activeScenario?.config || null;
  const hasUnsavedChanges = state.pendingConfig !== null;

  return (
    <div className="run-container">
      {activeScenario && currentConfig ? (
        <>
          <div className="run-header">
            <div className="header-title-section">
              <h1 className="run-title">{activeScenario.config.metadata.title || activeScenario.name}</h1>
              <p className="run-description">
                {activeScenario.config.metadata.description || 'Configure and test interoperability conversations'}
              </p>
            </div>
            <div className="header-actions">
              {state.activeScenarioId && (
                <>
                  <a href={`#/scenarios/${state.activeScenarioId}/run`} className="btn-action-header btn-run-header">
                    Run
                  </a>
                  <a href={`#/scenarios/${state.activeScenarioId}/run?mode=plugin`} className="btn-action-header btn-plugin-header">
                    Plug In
                  </a>
                </>
              )}
            </div>
          </div>
          <div className="run-content">
            <ScenarioEditor
              config={currentConfig}
              viewMode={state.viewMode}
              onViewModeChange={toggleViewMode}
              onConfigChange={updateConfigFromEditor}
              scenarioName={activeScenario.name}
              scenarioId={state.activeScenarioId}
              isViewMode={isViewMode}
            />
            <ChatPanel
              messages={state.chatHistory}
              onSendMessage={sendMessage}
              isLoading={state.isWaitingForLLM}
              onStop={stopGeneration}
              lastUserMessage={state.lastUserMessage}
              selectedModel={state.selectedModel}
              onModelChange={(model) => setState(prev => ({ ...prev, selectedModel: model }))}
              availableProviders={state.availableProviders}
            />
          </div>
        </>
      ) : (
        <div className="empty-state">
          <p className="empty-state-text">
            {state.isLoading ? 'Loading scenario...' : 'Scenario not found'}
          </p>
        </div>
      )}

      {hasUnsavedChanges && (
        <SaveBar
          onSave={saveChanges}
          onDiscard={discardChanges}
          isSaving={state.isSaving}
        />
      )}

      {state.error && (
        <div className="error-toast">
          {state.error}
        </div>
      )}
    </div>
  );
}