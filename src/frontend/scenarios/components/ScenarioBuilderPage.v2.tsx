import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { applyPatch } from 'fast-json-patch';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import type { ScenarioItem } from '$src/db/scenario.store';
type JSONPatchOperation = { op: 'add'|'remove'|'replace'|'copy'|'move'|'test'; path: string; value?: unknown; from?: string };
import { ChatPanel } from './ChatPanel';
import { ScenarioEditor } from './ScenarioEditor';
import { SaveBar } from './SaveBar';
import { Button } from '../../ui';
import { api } from '../utils/api';
import { createDefaultScenario, createBlankScenario } from '../utils/defaults';
import { buildScenarioBuilderPrompt } from '../utils/prompt-builder';
import { parseBuilderLLMResponse } from '../utils/response-parser';
import { getCuratedSchemaText, getExampleScenarioText } from '../utils/schema-loader';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
  toolCalls?: {
    patches?: JSONPatchOperation[];
    replaceEntireScenario?: ScenarioConfiguration;
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
  wascanceled: boolean;
}

export function ScenarioBuilderPage() {
  const { scenarioId } = useParams<{ scenarioId?: string }>();
  const navigate = useNavigate();
  const isCreateMode = window.location.hash.includes('/create');
  const isEditMode = window.location.hash.includes('/edit') || isCreateMode;
  const isViewMode = !isEditMode;
  
  // Get scenario idea from URL params
  const getScenarioIdea = () => {
    const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
    const idea = params.get('idea');
    if (idea) {
      try {
        return decodeURIComponent(idea);
      } catch {
        return null;
      }
    }
    return null;
  };
  
  // Get saved model from localStorage or use default
  const getSavedModel = () => {
    try {
      const saved = localStorage.getItem('scenario-builder-preferred-model');
      return saved || 'gemini-2.5-flash-lite';
    } catch {
      return 'gemini-2.5-flash-lite';
    }
  };
  
  const [state, setState] = useState<BuilderState>({
    scenarios: [],
    activeScenarioId: null,
    pendingConfig: null,
    chatHistory: [],
    viewMode: 'structured',
    isLoading: true,
    error: null,
    isSaving: false,
    selectedModel: getSavedModel(),
    schemaText: '',
    examplesText: '',
    isWaitingForLLM: false,
    lastUserMessage: '',
    availableProviders: [],
    wascanceled: false
  });
  
  // Store the abort controller outside of state
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const hasAutoSubmittedRef = React.useRef(false);

  // Load scenarios and schema on mount
  useEffect(() => {
    // Only load scenarios if not in create mode
    if (!isCreateMode) {
      loadScenarios();
    }
    loadSchemaAndConfig();
  }, []);

  // Handle route changes
  useEffect(() => {
    if (isCreateMode) {
      // Initialize create mode with blank scenario
      const blankScenario = createBlankScenario();
      
      setState(prev => ({
        ...prev,
        activeScenarioId: 'new',
        pendingConfig: blankScenario,
        chatHistory: [], // Start with empty history - auto-submit will add the message
        isLoading: false
      }));
    } else if (scenarioId && scenarioId !== state.activeScenarioId) {
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
  }, [scenarioId, isCreateMode]);

  // Auto-submit message in create mode once schema is loaded
  useEffect(() => {
    console.log('[Auto-submit] Checking conditions:');
    console.log('  isCreateMode:', isCreateMode);
    console.log('  state.schemaText:', !!state.schemaText);
    console.log('  state.activeScenarioId:', state.activeScenarioId);
    console.log('  hasAutoSubmittedRef.current:', hasAutoSubmittedRef.current);
    console.log('  state.chatHistory.length:', state.chatHistory.length);
    console.log('  state.isWaitingForLLM:', state.isWaitingForLLM);
    
    if (isCreateMode && state.schemaText && state.activeScenarioId === 'new' && !hasAutoSubmittedRef.current && !state.isWaitingForLLM) {
      const scenarioIdea = getScenarioIdea();
      console.log('[Auto-submit] Scenario idea:', scenarioIdea);
      
      if (scenarioIdea && state.chatHistory.length === 0) { // Check for empty history
        console.log('[Auto-submit] All conditions met, triggering auto-submit');
        hasAutoSubmittedRef.current = true;
        
        const message = `I want to create a new scenario: ${scenarioIdea}\n\nPlease help me build this scenario with appropriate agents, tools, and interaction dynamics.`;
        
        // Small delay to ensure all state is ready
        setTimeout(() => {
          console.log('[Auto-submit] Calling sendMessage now');
          sendMessage(message);
        }, 500);
      }
    }
  }, [isCreateMode, state.schemaText, state.activeScenarioId, state.chatHistory.length, state.isWaitingForLLM]);

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
        // Filter out providers we don't want to expose to users and those that aren't available
        const providersAll = llmConfig.data.providers;
        const providers = providersAll.filter((p: any) => 
          p.name !== 'browserside' && 
          p.name !== 'mock' && 
          p.available !== false
        );
        const savedModel = getSavedModel();
        
        // Check if saved model is still available in the filtered providers
        let modelExists = false;
        for (const provider of providers) {
          if (provider.models?.includes(savedModel)) {
            modelExists = true;
            break;
          }
        }
        
        let defaultModel = savedModel;
        
        // If saved model doesn't exist, find a new default
        if (!modelExists) {
          defaultModel = 'gemini-2.5-flash-lite';
          
          // Try to find a 'lite' model first
          for (const provider of providers) {
            const liteModel = provider.models?.find((m: string) => m.includes('lite'));
            if (liteModel) {
              defaultModel = liteModel;
              break;
            }
          }
          
          // If no 'lite' model found, try 'flash'
          if (!providers.some((p: any) => p.models?.some((m: string) => m.includes('lite')))) {
            for (const provider of providers) {
              const flashModel = provider.models?.find((m: string) => m.includes('flash'));
              if (flashModel) {
                defaultModel = flashModel;
                break;
              }
            }
          }
          
          // If no 'lite' or 'flash' model found, use first available model
          if (!providers.some((p: any) => p.models?.some((m: string) => m.includes('lite') || m.includes('flash'))) 
              && providers.length > 0 && providers[0].models?.length > 0) {
            defaultModel = providers[0].models[0];
          }
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
    console.log('[sendMessage] Called with:', userText);
    console.log('[sendMessage] activeScenarioId:', state.activeScenarioId);
    console.log('[sendMessage] isWaitingForLLM:', state.isWaitingForLLM);
    
    if (!state.activeScenarioId || state.isWaitingForLLM) return;

    // In create mode (activeScenarioId === 'new'), there's no active scenario in the list
    const active = state.activeScenarioId === 'new' 
      ? null 
      : state.scenarios.find(s => s.config.metadata.id === state.activeScenarioId);
    
    console.log('[sendMessage] Found active scenario:', active);
    
    // In create mode, we use pendingConfig; otherwise use the active scenario's config
    if (!active && state.activeScenarioId !== 'new') {
      console.log('[sendMessage] No active scenario found and not in create mode, returning');
      return;
    }

    // Always clone before patching to avoid in-place mutation
    const baseScenario = state.pendingConfig || active?.config;
    if (!baseScenario) {
      console.log('[sendMessage] No base scenario available, returning');
      return;
    }
    
    const currentScenario = JSON.parse(JSON.stringify(baseScenario)); // Deep clone
    
    // Create new abort controller for this request
    const controller = new AbortController();
    abortControllerRef.current = controller;
    
    // Create new user message
    const newUserMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: userText,
      timestamp: Date.now()
    };

    setState(prev => ({
      ...prev,
      chatHistory: [...prev.chatHistory, newUserMessage],
      isWaitingForLLM: true,
      lastUserMessage: userText,
      wascanceled: false
    }));

    try {
      // Ensure schema is loaded
      if (!state.schemaText) {
        await loadSchemaAndConfig();
      }
      
      // Use effectiveHistory including the new user turn
      const effectiveHistory = [...state.chatHistory, newUserMessage];
      
      console.log('=== CHAT HISTORY DEBUG ===');
      console.log('State chat history length:', state.chatHistory.length);
      console.log('Effective history length:', effectiveHistory.length);
      console.log('Effective history:', effectiveHistory.map(h => ({
        role: h.role,
        content: h.content.substring(0, 100) + (h.content.length > 100 ? '...' : ''),
        toolCalls: h.toolCalls
      })));
      
      const prompt = buildScenarioBuilderPrompt({
        scenario: currentScenario,
        history: effectiveHistory.map(h => ({ 
          role: h.role, 
          content: h.content,
          toolCalls: h.toolCalls 
        })),
        userMessage: userText,
        schemaText: state.schemaText,
        examplesText: state.examplesText,
        modelCapabilitiesNote: '' // optional
      });
      
      console.log('=== GENERATED PROMPT ===');
      console.log('Prompt length:', prompt.length);
      console.log('Full prompt:');
      console.log(prompt);
      console.log('=== END PROMPT ===');
      
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
          // Request was canceled - remove the user message and reset
          setState(prev => ({
            ...prev,
            chatHistory: prev.chatHistory.slice(0, -1), // Remove last message
            isWaitingForLLM: false,
            wascanceled: true
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
          // Use the 4th parameter (false) to prevent mutation
          const patchResult = applyPatch(currentScenario, builderResult.patches, false, false);
          nextScenario = patchResult.newDocument as typeof currentScenario;
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
        if (!repl?.metadata || !Array.isArray(repl?.agents)) {
          const errorMsg = {
            id: `msg_${Date.now() + 2}`,
            role: 'assistant' as const,
            content: 'Replacement scenario is missing required fields (metadata/agents).',
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
        pendingConfig: nextScenario, // Already a new object from cloning above
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
      let response;
      
      if (state.activeScenarioId === 'new') {
        // Create new scenario
        const name = state.pendingConfig.metadata.title || 'Untitled Scenario';
        response = await api.createScenario(name, state.pendingConfig);
        
        if (response.success) {
          // Navigate to the new scenario's edit page using metadata.id
          const newId = response.data.config.metadata.id;
          await loadScenarios(); // Refresh the scenarios list
          navigate(`/scenarios/${newId}/edit`);
          
          // Update local state with the new scenario
          setState(prev => ({
            ...prev,
            activeScenarioId: newId,
            pendingConfig: null,
            isSaving: false
          }));
        }
      } else {
        // Update existing scenario
        response = await api.updateScenarioConfig(
          state.activeScenarioId,
          state.pendingConfig
        );

        if (response.success) {
          // Update local state
          setState(prev => ({
            ...prev,
            scenarios: prev.scenarios.map(s =>
              s.config.metadata.id === state.activeScenarioId
                ? { ...s, config: state.pendingConfig!, modified: Date.now() }
                : s
            ),
            pendingConfig: null,
            isSaving: false
          }));
        }
      }
      
      if (!response.success) {
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
    console.log('[ScenarioBuilderPage] updateConfigFromEditor called, setting pendingConfig');
    setState(prev => ({ ...prev, pendingConfig: newConfig }));
  };

  const toggleViewMode = (mode: 'structured' | 'rawJson') => {
    setState(prev => ({ ...prev, viewMode: mode }));
  };

  const activeScenario = state.scenarios.find(s => s.config.metadata.id === state.activeScenarioId);
  // Use useMemo to ensure currentConfig reference changes when pendingConfig changes
  const currentConfig = React.useMemo(() => {
    return state.pendingConfig || activeScenario?.config || null;
  }, [state.pendingConfig, activeScenario?.config]);
  // Show unsaved changes when there's pending config with meaningful content
  const hasUnsavedChanges = state.pendingConfig !== null && (
    // Has a metadata.id (even if empty string initially)
    state.pendingConfig.metadata?.id !== undefined &&
    // And has some meaningful content (agents or background)
    (state.pendingConfig.agents?.length > 0 || 
     state.pendingConfig.metadata?.background?.trim() ||
     state.pendingConfig.metadata?.description?.trim())
  );
  

  return (
    <div className="min-h-screen">
      {(activeScenario || isCreateMode) && currentConfig ? (
        <div>
          <div className="container mx-auto px-4 py-4">
            <div className={`grid items-start gap-4 ${(isEditMode || isCreateMode) ? 'grid-cols-1 lg:grid-cols-[1fr_20rem]' : 'grid-cols-1'} min-h-0`}>
              <main className="min-w-0">
                <ScenarioEditor
                  config={currentConfig}
                  viewMode={state.viewMode}
                  onViewModeChange={toggleViewMode}
                  onConfigChange={updateConfigFromEditor}
                  scenarioName={activeScenario?.name || 'New Scenario'}
                  scenarioId={isCreateMode ? undefined : state.activeScenarioId}
                  isViewMode={isViewMode}
                  isEditMode={isEditMode}
                />
              </main>
              {(isEditMode || isCreateMode) && (
                <aside className="lg:sticky lg:top-16 lg:h-[calc(100vh-4rem)]">
                  <div className={`h-full ${hasUnsavedChanges ? 'pb-20' : ''}`}>
                    <ChatPanel
                      messages={state.chatHistory}
                      onSendMessage={sendMessage}
                      isLoading={state.isWaitingForLLM}
                      onStop={stopGeneration}
                      lastUserMessage={state.lastUserMessage}
                      wascanceled={state.wascanceled}
                      selectedModel={state.selectedModel}
                      onModelChange={(model) => {
                        // Save to localStorage
                        try {
                          localStorage.setItem('scenario-builder-preferred-model', model);
                        } catch (e) {
                          console.error('Failed to save model preference:', e);
                        }
                        setState(prev => ({ ...prev, selectedModel: model }));
                      }}
                      availableProviders={state.availableProviders}
                    />
                  </div>
                </aside>
              )}
            </div>
          </div>
        </div>
      ) : (
        <div className="flex items-center justify-center py-12">
          <p className="text-gray-500">
            {state.isLoading ? 'Loading scenario...' : 'Scenario not found'}
          </p>
        </div>
      )}

      {hasUnsavedChanges && (
        <div className="fixed bottom-0 left-0 lg:w-[66%] right-0 lg:right-auto bg-amber-50 border-t border-amber-200 p-3 flex justify-between items-center shadow-lg z-20">
          <div className="text-sm text-amber-800">
            You have unsaved changes
          </div>
          <div className="flex gap-2">
            <Button variant="secondary" size="sm" onClick={discardChanges} disabled={state.isSaving}>Discard Changes</Button>
            <Button variant="primary" size="sm" onClick={saveChanges} disabled={state.isSaving}>
              {state.isSaving ? 'Saving...' : (isCreateMode ? 'Create Scenario' : 'Save to Backend')}
            </Button>
          </div>
        </div>
      )}

      {state.error && (
        <div className="fixed bottom-4 right-4 p-3 bg-red-50 text-red-700 border border-red-200 rounded-md shadow-lg">
          {state.error}
        </div>
      )}
    </div>
  );
}
