import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { ChatPanel } from './ChatPanel';
import { ScenarioEditor } from './ScenarioEditor';
import { SaveBar } from './SaveBar';
import { api } from '../utils/api';
import { createBlankScenario, createDefaultScenario } from '../utils/defaults';
import { buildScenarioBuilderPrompt } from '../utils/prompt-builder';
import { parseBuilderLLMResponse } from '../utils/response-parser';
import { getCuratedSchemaText, getExampleScenarioText } from '../utils/schema-loader';

interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string; timestamp: number; toolCalls?: { patches?: any[]; replaceEntireScenario?: any } }

export function ScenarioBuilderPage() {
  const { scenarioId } = useParams<{ scenarioId?: string }>();
  const navigate = useNavigate();
  const isCreateMode = window.location.hash.includes('/create');
  const isEditMode = window.location.hash.includes('/edit') || isCreateMode;
  const isViewMode = !isEditMode;

  const [state, setState] = useState({
    scenarios: [] as any[],
    activeScenarioId: null as string | null,
    pendingConfig: null as any,
    chatHistory: [] as ChatMessage[],
    viewMode: 'structured' as 'structured' | 'rawJson',
    isLoading: true,
    error: null as string | null,
    isSaving: false,
    selectedModel: 'gemini-2.5-flash-lite',
    schemaText: '',
    examplesText: '',
    isWaitingForLLM: false,
    lastUserMessage: '',
    availableProviders: [] as Array<{ name: string; models: string[] }>,
    wascanceled: false,
  });

  const abortControllerRef = useRef<AbortController | null>(null);
  const hasAutoSubmittedRef = useRef(false);

  useEffect(() => { if (!isCreateMode) loadScenarios(); loadSchemaAndConfig(); }, []);
  useEffect(() => {
    if (isCreateMode) {
      const blank = createBlankScenario();
      setState((prev) => ({ ...prev, activeScenarioId: 'new', pendingConfig: blank, chatHistory: [], isLoading: false }));
    } else if (scenarioId && scenarioId !== state.activeScenarioId) {
      selectScenario(scenarioId);
    } else if (!scenarioId && state.activeScenarioId) {
      setState((prev) => ({ ...prev, activeScenarioId: null, pendingConfig: null, chatHistory: [] }));
    }
  }, [scenarioId, isCreateMode]);

  useEffect(() => {
    if (isCreateMode && state.schemaText && state.activeScenarioId === 'new' && !hasAutoSubmittedRef.current && !state.isWaitingForLLM) {
      const params = new URLSearchParams(window.location.hash.split('?')[1] || '');
      const idea = params.get('idea');
      if (idea && state.chatHistory.length === 0) {
        hasAutoSubmittedRef.current = true;
        const message = `I want to create a new scenario: ${decodeURIComponent(idea)}\n\nPlease help me build this scenario with appropriate agents, tools, and interaction dynamics.`;
        setTimeout(() => sendMessage(message), 300);
      }
    }
  }, [isCreateMode, state.schemaText, state.activeScenarioId, state.chatHistory.length, state.isWaitingForLLM]);

  async function loadScenarios() {
    setState((p) => ({ ...p, isLoading: true, error: null }));
    try {
      const res = await api.getScenarios();
      if (res.success) setState((p) => ({ ...p, scenarios: res.data.scenarios, isLoading: false }));
      else throw new Error('Failed to load scenarios');
    } catch (e: any) {
      setState((p) => ({ ...p, isLoading: false, error: e?.message || 'Failed to load scenarios' }));
    }
  }

  async function loadSchemaAndConfig() {
    const schemaText = getCuratedSchemaText();
    const examplesText = getExampleScenarioText();
    try {
      const cfg = await api.getLLMConfig();
      const providers = cfg.success ? cfg.data.providers : [];
      let defaultModel = state.selectedModel;
      if (providers.length) {
        const all = providers.flatMap((p: any) => p.models || []);
        if (!all.includes(defaultModel)) defaultModel = all.find((m: string) => m.includes('lite')) || all[0] || defaultModel;
      }
      setState((p) => ({ ...p, schemaText, examplesText, selectedModel: defaultModel, availableProviders: providers }));
    } catch {
      setState((p) => ({ ...p, schemaText, examplesText, availableProviders: [] }));
    }
  }

  async function selectScenario(id: string) {
    setState((p) => ({ ...p, isLoading: true, error: null }));
    try {
      const res = await api.getScenario(id);
      if (res.success) {
        const scenario = res.data;
        setState((p) => ({ ...p, activeScenarioId: id, chatHistory: scenario.history || [], pendingConfig: null, isLoading: false }));
      } else throw new Error('Failed to load scenario');
    } catch (e: any) {
      setState((p) => ({ ...p, isLoading: false, error: e?.message || 'Failed to load scenario' }));
    }
  }

  async function createNewScenario() {
    const name = prompt('Enter scenario name:'); if (!name) return;
    try {
      const config = createDefaultScenario();
      const res = await api.createScenario(name, config);
      if (res.success) { await loadScenarios(); navigate(`/scenarios/${res.data.id}/edit`); }
      else throw new Error('Failed to create scenario');
    } catch (e: any) {
      setState((p) => ({ ...p, error: e?.message || 'Failed to create scenario' }));
    }
  }

  async function deleteScenario(id: string) {
    if (!confirm('Delete this scenario?')) return;
    try {
      const res = await api.deleteScenario(id);
      if (res.success) { await loadScenarios(); if (state.activeScenarioId === id) setState((p) => ({ ...p, activeScenarioId: null, chatHistory: [], pendingConfig: null })); }
      else throw new Error('Failed');
    } catch (e: any) {
      setState((p) => ({ ...p, error: e?.message || 'Failed to delete scenario' }));
    }
  }

  async function sendMessage(userText: string) {
    if (!state.activeScenarioId || state.isWaitingForLLM) return;
    const active = state.activeScenarioId === 'new' ? null : state.scenarios.find((s) => s.config.metadata.id === state.activeScenarioId);
    const base = state.pendingConfig || active?.config; if (!base) return;
    const currentScenario = JSON.parse(JSON.stringify(base));
    const controller = new AbortController(); abortControllerRef.current = controller;
    const newUser: ChatMessage = { id: `msg_${Date.now()}`, role: 'user', content: userText, timestamp: Date.now() };
    setState((p) => ({ ...p, chatHistory: [...p.chatHistory, newUser], isWaitingForLLM: true, lastUserMessage: userText, wascanceled: false }));
    try {
      if (!state.schemaText) await loadSchemaAndConfig();
      const effectiveHistory = [...state.chatHistory, newUser];
      const prompt = buildScenarioBuilderPrompt({ scenario: currentScenario, history: effectiveHistory.map(h => ({ role: h.role, content: h.content, toolCalls: h.toolCalls })), userMessage: userText, schemaText: state.schemaText, examplesText: state.examplesText, modelCapabilitiesNote: '' });
      const llm = await api.generateLLM({ messages: [{ role: 'user', content: prompt }], model: state.selectedModel, temperature: 0.2 }, controller.signal);
      const parsed = parseBuilderLLMResponse(llm.data.content);
      let next = currentScenario;
      if (parsed.patches?.length) {
        // naive patch apply
        for (const p of parsed.patches) {
          if (p.op === 'replace') {
            const path = p.path.replace(/^\//,'').split('/').map(decodeURIComponent);
            let obj: any = next; for (let i = 0; i < path.length - 1; i++) obj = obj[path[i]!]; obj[path[path.length-1]!] = p.value;
          }
        }
      } else if (parsed.replaceEntireScenario) {
        next = parsed.replaceEntireScenario;
      }
      const assistant: ChatMessage = { id: `msg_${Date.now()+1}`, role: 'assistant', content: 'Applied changes to the scenario.', timestamp: Date.now(), toolCalls: { patches: parsed.patches, replaceEntireScenario: parsed.replaceEntireScenario } };
      setState((p) => ({ ...p, chatHistory: [...p.chatHistory, assistant], isWaitingForLLM: false, pendingConfig: next }));
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        setState((p) => ({ ...p, chatHistory: p.chatHistory.slice(0, -1), isWaitingForLLM: false, wascanceled: true }));
        return;
      }
      const assistant: ChatMessage = { id: `msg_${Date.now()+1}`, role: 'assistant', content: `Error calling LLM: ${err?.message || err}`, timestamp: Date.now() };
      setState((p) => ({ ...p, chatHistory: [...p.chatHistory, assistant], isWaitingForLLM: false }));
    }
  }

  const activeConfig = state.pendingConfig;
  const activeScenarioName = state.activeScenarioId === 'new' ? 'New Scenario' : (state.scenarios.find((s) => s.config.metadata.id === state.activeScenarioId)?.name || '');

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="font-semibold">{isCreateMode ? 'Create Scenario' : 'Edit Scenario'}</div>
          {!isCreateMode && <button className="px-2 py-1 text-xs bg-rose-600 text-white rounded" onClick={() => state.activeScenarioId && deleteScenario(state.activeScenarioId)}>Delete</button>}
        </div>
        {activeConfig ? (
          <ScenarioEditor
            config={activeConfig}
            viewMode={state.viewMode}
            onViewModeChange={(m) => setState((p) => ({ ...p, viewMode: m }))}
            onConfigChange={(cfg) => setState((p) => ({ ...p, pendingConfig: cfg }))}
            scenarioName={activeScenarioName}
            scenarioId={state.activeScenarioId || undefined}
            isViewMode={isViewMode}
            isEditMode={isEditMode}
          />
        ) : state.isLoading ? (
          <div className="text-slate-500">Loading…</div>
        ) : (
          <div className="text-slate-500">No scenario selected.</div>
        )}
        <SaveBar onSave={async () => {
          if (!state.activeScenarioId) return;
          await api.updateScenarioConfig(state.activeScenarioId, state.pendingConfig);
          setState((p) => ({ ...p, isSaving: false }));
        }} disabled={state.isSaving || !state.pendingConfig} scenarioId={state.activeScenarioId || undefined} />
      </div>
      <div className="min-h-[560px]">
        <ChatPanel
          messages={state.chatHistory}
          onSendMessage={sendMessage}
          isLoading={state.isWaitingForLLM}
          onStop={() => { abortControllerRef.current?.abort(); }}
          lastUserMessage={state.lastUserMessage}
          wascanceled={state.wascanceled}
          selectedModel={state.selectedModel}
          onModelChange={(m) => { localStorage.setItem('scenario-builder-preferred-model', m); setState((p) => ({ ...p, selectedModel: m })); }}
          availableProviders={state.availableProviders}
        />
      </div>
    </div>
  );
}

