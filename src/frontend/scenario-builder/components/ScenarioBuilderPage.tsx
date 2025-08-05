import React, { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { applyPatch } from 'fast-json-patch';
import type { ScenarioConfiguration, ScenarioItem, JSONPatchOperation } from '$lib/types.js';
import { ChatPanel } from './ChatPanel.js';
import { ScenarioEditor } from './ScenarioEditor.js';
import { SaveBar } from './SaveBar.js';
import { api } from '../utils/api.js';
import { createDefaultScenario } from '../utils/defaults.js';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
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
    isSaving: false
  });

  // Load scenarios on mount
  useEffect(() => {
    loadScenarios();
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

  const sendMessage = async (message: string) => {
    if (!state.activeScenarioId) return;

    const activeScenario = state.scenarios.find(s => s.id === state.activeScenarioId);
    if (!activeScenario) return;

    const currentConfig = state.pendingConfig || activeScenario.config;
    
    // Add user message to chat
    const userMessage: ChatMessage = {
      id: `msg_${Date.now()}`,
      role: 'user',
      content: message,
      timestamp: Date.now()
    };

    setState(prev => ({
      ...prev,
      chatHistory: [...prev.chatHistory, userMessage]
    }));

    try {
      const response = await api.chatWithScenario(
        state.activeScenarioId,
        message,
        state.chatHistory
      );

      if (response.success) {
        const { assistantMessage, patches, replaceEntireScenario } = response.data;
        
        // Add assistant message to chat
        const assistantMsg: ChatMessage = {
          id: `msg_${Date.now() + 1}`,
          role: 'assistant',
          content: assistantMessage,
          timestamp: Date.now()
        };

        let newConfig = currentConfig;

        // Apply patches or replacement
        if (replaceEntireScenario) {
          newConfig = replaceEntireScenario;
        } else if (patches && patches.length > 0) {
          try {
            newConfig = applyPatch(currentConfig, patches).newDocument;
          } catch (patchError) {
            console.error('Failed to apply patches:', patchError);
            throw new Error('Failed to apply changes to scenario');
          }
        }

        setState(prev => ({
          ...prev,
          chatHistory: [...prev.chatHistory, assistantMsg],
          pendingConfig: newConfig
        }));
      } else {
        throw new Error(response.error || 'Failed to process message');
      }
    } catch (error) {
      const errorMsg: ChatMessage = {
        id: `msg_${Date.now() + 1}`,
        role: 'assistant',
        content: `Error: ${error instanceof Error ? error.message : 'Failed to process message'}`,
        timestamp: Date.now()
      };
      setState(prev => ({
        ...prev,
        chatHistory: [...prev.chatHistory, errorMsg]
      }));
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
              isLoading={false}
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