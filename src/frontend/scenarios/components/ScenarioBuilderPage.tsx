import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { applyPatch } from 'fast-json-patch';
import type { ScenarioConfiguration } from '../../../types/scenario-configuration.types';
type ScenarioItem = { id: string; name: string; config: any; history: any[]; createdAt: string; modifiedAt: string };
type JSONPatchOperation = { op: 'add'|'remove'|'replace'|'copy'|'move'|'test'; path: string; value?: unknown; from?: string };
import { ChatPanel } from './ChatPanel';
import { ScenarioEditor } from './ScenarioEditor';
import { SaveBar } from './SaveBar';
import { Button } from '../../ui';
import { api } from '../utils/api';
import { createBlankScenario } from '../utils/defaults';
import { buildScenarioBuilderPrompt } from '../utils/prompt-builder';
import { parseBuilderLLMResponse } from '../utils/response-parser';
import { getCuratedSchemaText, getExampleScenarioText } from '../utils/schema-loader';
import { isPublished, isUnlockedFor, setUnlocked, getEditToken, setEditToken, clearEditToken, clearUnlocked, isDeleted } from '../utils/locks';

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
  configRevision: number; // bump to force editor sync to programmatic changes
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
    wascanceled: false,
    configRevision: 0
  });
  
  // Store the abort controller outside of state
  const abortControllerRef = React.useRef<AbortController | null>(null);
  const hasAutoSubmittedRef = React.useRef(false);
  const [initialInput, setInitialInput] = React.useState<string | undefined>(undefined);
  const [unlockModalOpen, setUnlockModalOpen] = React.useState(false);
  const [pendingToken, setPendingToken] = React.useState('');
  const [unlockError, setUnlockError] = React.useState<string | null>(null);

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

  // Populate input field with scenario idea when creating with ?idea parameter
  useEffect(() => {
    if (isCreateMode && state.schemaText && state.activeScenarioId === 'new' && !hasAutoSubmittedRef.current && !state.isWaitingForLLM) {
      const scenarioIdea = getScenarioIdea();
      
      if (scenarioIdea && state.chatHistory.length === 0) { // Check for empty history
        hasAutoSubmittedRef.current = true;
        
        const message = `I want to create a new scenario: ${scenarioIdea}\n\nPlease help me build this scenario with appropriate agents, tools, and interaction dynamics.`;
        
        // Set the initial input instead of auto-sending
        setInitialInput(message);
      }
    }
  }, [isCreateMode, state.schemaText, state.activeScenarioId, state.chatHistory.length, state.isWaitingForLLM]);

  const loadScenarios = async () => {
    setState(prev => ({ ...prev, isLoading: true, error: null }));
    try {
      const response = await api.getScenarios();
      if (!response.success) throw new Error('Failed to load scenarios');
      // Map to ScenarioItem shape with createdAt/modifiedAt placeholders
      const scenarios: ScenarioItem[] = (response.data.scenarios || []).map((s:any) => ({
        id: s.id,
        name: s.name,
        config: s.config,
        history: s.history || [],
        createdAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
      }));
      setState(prev => ({ ...prev, scenarios, isLoading: false }));
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
        const providersAll: Array<{ name:string; models?: string[]; available?: boolean }> = llmConfig.data.providers as any[];
        const avail = providersAll.filter(p => p.available !== false);
        const unionModels = Array.from(new Set(avail.flatMap(p => Array.isArray(p.models) ? p.models : []))).filter(Boolean) as string[];

        // Prefer showing real providers (excluding mock) when they advertise models; otherwise show a single 'server' group
        let providers: Array<{ name: string; models: string[] }> = avail
          .filter(p => p.name !== 'mock' && Array.isArray(p.models) && p.models!.length > 0)
          .map(p => ({ name: p.name, models: p.models as string[] }));
        if (providers.length === 0) {
          const fallbackModels = unionModels.length ? unionModels : ['@preset/banterop'];
          providers = [{ name: 'server', models: fallbackModels }];
        }

        // Pick default model: saved one if still present; else first available from providers; else fallback
        const savedModel = getSavedModel();
        const modelExists = providers.some(p => p.models.includes(savedModel));
        const defaultModel = modelExists ? savedModel : (providers[0]?.models?.[0] || '@preset/banterop');

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
        availableProviders: [{ name:'server', models: ['@preset/banterop'] }]
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
      if (!response.success) throw new Error('Failed to load scenario');
      const scenario = response.data;
      setState(prev => ({
        ...prev,
        activeScenarioId: id,
        chatHistory: scenario.history || [],
        // No pending edits upon load; pendingConfig is only set when user makes a change
        pendingConfig: null,
        configRevision: prev.configRevision + 1,
        isLoading: false
      }));
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

  // Immediate-persist create flow removed; creation happens via blank scenario route

  const deleteScenario = async (id: string) => {
    const name = state.scenarios.find(s => s.config?.metadata?.id === id)?.config?.metadata?.title || id;
    if (!confirm(`Move scenario "${name}" to Deleted? You can restore it later from the Deleted view.`)) return;

    try {
      const response = await api.deleteScenario(id);
      if (response.success) {
        // Clear local state and navigate back to list (Deleted view)
        setState(prev => ({ ...prev, activeScenarioId: null, chatHistory: [], pendingConfig: null }));
        await loadScenarios();
        navigate('/scenarios?view=deleted');
      } else {
        throw new Error('Failed to delete scenario');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to delete scenario'
      }));
    }
  };

  const restoreScenario = async (id: string) => {
    const name = state.scenarios.find(s => s.config?.metadata?.id === id)?.config?.metadata?.title || id;
    if (!confirm(`Restore scenario "${name}" from Deleted?`)) return;
    try {
      const response = await api.restoreScenario(id);
      if (response.success) {
        await loadScenarios();
        // remain on the same editor view
        setState(prev => ({ ...prev, pendingConfig: null }));
        navigate(`/scenarios/${id}/edit`);
      } else {
        throw new Error('Failed to restore scenario');
      }
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : 'Failed to restore scenario'
      }));
    }
  };

  const sendMessage = async (userText: string) => {
    if (!state.activeScenarioId || state.isWaitingForLLM) return;

    // In create mode (activeScenarioId === 'new'), there's no active scenario in the list
    const active = state.activeScenarioId === 'new' 
      ? null 
      : state.scenarios.find(s => s.config.metadata.id === state.activeScenarioId);
    
    // In create mode, we use pendingConfig; otherwise use the active scenario's config
    if (!active && state.activeScenarioId !== 'new') {
      return;
    }

    // Always clone before patching to avoid in-place mutation
    const baseScenario = state.pendingConfig || active?.config;
    if (!baseScenario) {
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
      
      // 2) Call LLM generate (server routing, no scenario-chat endpoint)
      let llmResponse;
      try {
        llmResponse = await api.generateLLM({
          messages: [{ role: 'user', content: prompt }],
          model: state.selectedModel,
          temperature: 0.2
        }, controller.signal, state.activeScenarioId || undefined);
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
      let nextScenario: any = currentScenario;
      if (builderResult.patches && builderResult.patches.length > 0) {
        try {
          // Use the 4th parameter (false) to prevent mutation
          const patchResult = applyPatch(currentScenario as any, builderResult.patches as any, false, false);
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
        const repl: any = builderResult.replaceEntireScenario;
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
          patches: builderResult.patches as any,
          replaceEntireScenario: builderResult.replaceEntireScenario as any
        }
      };
      
      setState(prev => ({
        ...prev,
        chatHistory: [...prev.chatHistory, assistantMsg],
        pendingConfig: nextScenario, // Already a new object from cloning above
        configRevision: prev.configRevision + 1,
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
      let response: any;
      
      if (state.activeScenarioId === 'new') {
        // Create new scenario
        const name = state.pendingConfig.metadata.title || 'Untitled Scenario';
        response = await api.createScenario(name, state.pendingConfig);
        
        if (response.success) {
          // Navigate to the new scenario's edit page using metadata.id
          const newId = String(response.data.config?.metadata?.id || state.activeScenarioId || '');
          await loadScenarios(); // Refresh the scenarios list
          navigate(`/scenarios/${newId}/edit`);
          
          // Update local state with the new scenario
          setState(prev => ({
            ...prev,
            activeScenarioId: newId,
            pendingConfig: null,
            configRevision: prev.configRevision + 1,
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
            configRevision: prev.configRevision + 1,
            isSaving: false
          }));
        }
      }
      
      if (!response.success) {
        throw new Error('Failed to save changes');
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
    setState(prev => ({ ...prev, pendingConfig: null, configRevision: prev.configRevision + 1 }));
  };

  const updateConfigFromEditor = (newConfig: ScenarioConfiguration) => {
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
  const currentScenarioId = currentConfig?.metadata?.id as string | undefined;
  const isLocked = !!(currentConfig && isPublished(currentConfig) && !isUnlockedFor(currentScenarioId));
  const deleted = !!(currentConfig && isDeleted(currentConfig));
  // Show unsaved changes when there's pending config with meaningful content
  const hasUnsavedChanges = state.pendingConfig !== null && (
    // Has a metadata.id (even if empty string initially)
    state.pendingConfig.metadata?.id !== undefined &&
    // And has some meaningful content (agents or background)
    (state.pendingConfig.agents?.length > 0 || 
     state.pendingConfig.metadata?.background?.trim() ||
     state.pendingConfig.metadata?.description?.trim())
  );
  
  // In create mode, allow saving as long as we have a pending config
  const canSaveNow = isCreateMode ? !!state.pendingConfig : hasUnsavedChanges;

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
                  scenarioId={isCreateMode ? undefined : (state.activeScenarioId || undefined)}
                  isViewMode={!!(isViewMode || isLocked)}
                  isEditMode={!!isEditMode}
                  isLocked={!!isLocked}
                  isDeleted={!!deleted}
                  onDelete={(!deleted && !isCreateMode && state.activeScenarioId) ? () => deleteScenario(state.activeScenarioId!) : undefined}
                  onRestore={(deleted && !isCreateMode && state.activeScenarioId) ? () => restoreScenario(state.activeScenarioId!) : undefined}
                  onSave={(!isLocked && canSaveNow) ? saveChanges : undefined}
                  onDiscard={(!isLocked && hasUnsavedChanges) ? discardChanges : undefined}
                  canSave={!!canSaveNow}
                  isSaving={!!state.isSaving}
                  saveLabel={isCreateMode ? 'Create' : 'Save'}
                  configRevision={state.configRevision}
                />
                {isLocked && (
                  <div className="mt-3 p-3 bg-amber-50 border border-amber-200 rounded-md text-sm text-amber-800">
                    <div className="flex items-center justify-between">
                      <div>
                        This scenario is Published and protected against accidental edits.
                      </div>
                      <div className="flex items-center gap-2">
                        <Button size="sm" variant="secondary" onClick={() => { setUnlockModalOpen(true); setPendingToken(getEditToken()); setUnlockError(null); }}>Unlock to edit</Button>
                      </div>
                    </div>
                  </div>
                )}
              </main>
              {(isEditMode || isCreateMode) && (
                <aside className="sticky top-16 h-[calc(100vh-4rem)]">
                  <div className="h-full">
                    <ChatPanel
                      messages={state.chatHistory}
                      onSendMessage={sendMessage}
                      isLoading={state.isWaitingForLLM}
                      onStop={stopGeneration}
                      lastUserMessage={state.lastUserMessage}
                      wascanceled={state.wascanceled}
                      selectedModel={state.selectedModel}
                      initialInput={initialInput}
                      disabled={isLocked}
                      schemaText={state.schemaText}
                      showCopyHelper={isCreateMode}
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

      {false && hasUnsavedChanges && !isLocked && (
        <div />
      )}

      {state.error && (
        <div className="fixed bottom-4 right-4 p-3 bg-red-50 text-red-700 border border-red-200 rounded-md shadow-lg">
          {state.error}
        </div>
      )}

      {unlockModalOpen && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-30">
          <div className="bg-white rounded-lg shadow-lg p-4 w-full max-w-sm">
            <div className="text-sm font-semibold mb-2">Unlock to Edit</div>
            <div className="text-xs text-gray-600 mb-3">Enter edit token (if required). Unlock persists for 24 hours.</div>
            <input
              className="w-full border border-gray-300 rounded px-3 py-2 text-sm mb-2"
              placeholder="Edit token (optional)"
              value={pendingToken}
              onChange={(e) => setPendingToken(e.target.value)}
            />
            {unlockError && (
              <div className="text-xs text-red-700 bg-red-50 border border-red-200 rounded p-2 mb-2">{unlockError}</div>
            )}
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => { setUnlockModalOpen(false); setUnlockError(null); }}>Cancel</Button>
                <Button variant="primary" size="sm" onClick={() => {
                  try { setEditToken(pendingToken || ''); } catch {}
                  setUnlocked(currentScenarioId || '', true);
                  setUnlockModalOpen(false);
                  setUnlockError(null);
                }}>Unlock</Button>
              </div>
              {(isUnlockedFor(currentScenarioId) || getEditToken()) && (
                <div className="flex items-center gap-2">
                  {isUnlockedFor(currentScenarioId) && (
                    <Button size="sm" variant="secondary" onClick={() => { clearUnlocked(currentScenarioId); setUnlockModalOpen(false); }}>Lock again</Button>
                  )}
                  {getEditToken() && (
                    <button className="text-xs text-gray-500 underline" onClick={(e) => { e.preventDefault(); clearEditToken(); setPendingToken(''); }}>Forget token</button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
