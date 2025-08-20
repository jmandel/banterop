import React from "react";
import { Button, ModelSelect } from "../../../ui";
import { AttachmentBar } from "../Attachments/AttachmentBar";
import { useAppStore, getAttachmentVaultForUI } from "$src/frontend/client/stores/appStore";
import { API_BASE } from "$src/frontend/client/api-base";

interface ConfigurationStepProps {
  instructions?: string;
  onInstructionsChange?: (value: string) => void;
  // Scenario configuration (URL + agent selection)
  scenarioUrl?: string;
  onScenarioUrlChange?: (value: string) => void;
  onLoadScenarioUrl?: () => void;
  scenarioAgents?: string[];
  selectedPlannerAgentId?: string;
  onSelectPlannerAgentId?: (id: string) => void;
  selectedCounterpartAgentId?: string;
  tools?: Array<{ name: string; description?: string }>;
  enabledTools?: string[];
  onToggleTool?: (name: string, enabled: boolean) => void;
  providers?: Array<{ name: string; models: string[] }>;
  selectedModel?: string;
  onSelectedModelChange?: (model: string) => void;
  plannerStarted?: boolean;
  onStartPlanner?: () => void;
  onStopPlanner?: () => void;
  connected?: boolean;
  // Attachments
  attachments?: {
    vault: import("../../attachments-vault").AttachmentVault;
    onFilesSelect: (files: FileList | null) => void;
    onAnalyze: (name: string) => void;
    onOpenAttachment?: (name: string, mimeType: string, bytes?: string, uri?: string) => void;
    summarizeOnUpload: boolean;
    onToggleSummarize: (value: boolean) => void;
  };
}

export const ConfigurationStep: React.FC<ConfigurationStepProps> = () => {
  // Prefer Zustand store where available (kept in sync via binder)
  const store = useAppStore();
  const instructions = store.planner.instructions || "";
  const onInstructionsChange = (v: string) => store.actions.setInstructions(v);
  const scenarioUrl = store.scenario.url || "";
  const onScenarioUrlChange = (v: string) => store.actions.setScenarioUrl(v);
  const onLoadScenarioUrl = () => { const u = (scenarioUrl || '').trim(); if (u) void store.actions.loadScenario(); else store.actions.setScenarioUrl(''); };
  // Auto-fetch on edit with debounce for instant feedback
  React.useEffect(() => {
    const u = (scenarioUrl || '').trim();
    const t = setTimeout(() => {
      if (u) void store.actions.loadScenario();
    }, 400);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scenarioUrl]);
  const scenarioAgents = (Array.isArray((store.scenario.config as any)?.agents) ? ((store.scenario.config as any).agents as any[]).map(a => String(a?.agentId || '')).filter(Boolean) : []);
  const selectedPlannerAgentId = store.scenario.selectedAgents?.planner;
  const selectedCounterpartAgentId = store.scenario.selectedAgents?.counterpart;
  const enabledTools = store.scenario.enabledTools ?? [];
  const [providers, setProviders] = React.useState<Array<{ name: string; models: string[] }>>([]);
  const selectedModel = store.planner.model || "";
  const onSelectedModelChange = (m: string) => store.actions.setModel(m);
  React.useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_BASE}/llm/providers`);
        if (!res.ok) return;
        const list = await res.json();
        const filtered = (Array.isArray(list) ? list : []).filter((p: any) => p?.name !== 'browserside' && p?.name !== 'mock' && p?.available !== false);
        setProviders(filtered);
        if (!selectedModel) {
          const first = filtered.flatMap((p: any) => p.models || [])[0];
          if (first) onSelectedModelChange(first);
        }
      } catch {}
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const plannerStarted = store.planner.started ?? false;
  const onStartPlanner = () => { store.actions.startPlanner(); };
  const onStopPlanner = () => { store.actions.stopPlanner(); };
  const connected = (store.connection.status === 'connected');
  const onSelectPlannerAgentId = (id: string) => store.actions.selectAgent('planner', id);
  const tools = (() => {
    try {
      const cfg: any = store.scenario.config;
      const agent = Array.isArray(cfg?.agents) ? cfg.agents.find((a: any) => a?.agentId === selectedPlannerAgentId) : null;
      return Array.isArray(agent?.tools) ? (agent.tools as any[]).map((t: any) => ({ name: String(t?.toolName || t?.name || ''), description: t?.description ? String(t.description) : undefined })).filter((ti: any) => ti.name) : [];
    } catch { return []; }
  })();
  const onToggleTool = (name: string, enabled: boolean) => {
    const set = new Set(enabledTools);
    if (enabled) set.add(name); else set.delete(name);
    store.actions.setEnabledTools(Array.from(set));
  };
  const attachments = {
    vault: getAttachmentVaultForUI(),
    onFilesSelect: (files: FileList | null) => { void store.actions.uploadFiles(files); },
    onAnalyze: (name: string) => store.actions.analyzeAttachment(name),
    onOpenAttachment: (name: string) => { void store.actions.openAttachment(name); },
    summarizeOnUpload: useAppStore.getState().attachments.summarizeOnUpload,
    onToggleSummarize: (on: boolean) => store.actions.toggleSummarizeOnUpload(on),
  } as const;
  return (
    <div className="space-y-4">
      {/* Scenario URL + agent selection */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Scenario JSON URL</label>
          <div className="flex gap-2">
            <input
              type="url"
              value={scenarioUrl}
              onChange={(e) => onScenarioUrlChange(e.target.value)}
              placeholder="https://host/api/scenarios/<id>"
              className="flex-1 px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
            {onLoadScenarioUrl && (
              <Button variant="secondary" onClick={onLoadScenarioUrl} disabled={!scenarioUrl.trim()}>
                Load
              </Button>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-1">Paste a scenario endpoint to drive your agent's context.</p>
          {(() => {
            const err = useAppStore(s => s.scenario.error);
            const cfg = useAppStore(s => s.scenario.config as any);
            const loading = useAppStore(s => s.scenario.loading);
            if (loading) {
              return (
                <div className="mt-2 p-2 rounded border border-blue-200 bg-blue-50 text-sm text-blue-700">
                  Checking scenario…
                </div>
              );
            }
            if (err) {
              return (
                <div className="mt-2 p-2 rounded border border-red-200 bg-red-50 text-sm text-red-700">
                  Scenario load error: {err}
                </div>
              );
            }
            if (cfg && Array.isArray(cfg?.agents)) {
              const count = (cfg.agents as any[]).length;
              return (
                <div className="mt-2 p-2 rounded border border-green-200 bg-green-50 text-sm text-green-700">
                  Scenario loaded • Agents: {count}
                </div>
              );
            }
            return null;
          })()}
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Your Role</label>
          <select
            value={selectedPlannerAgentId || ''}
            onChange={(e) => onSelectPlannerAgentId(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            disabled={!scenarioAgents.length}
          >
            <option value="" disabled>
              {scenarioAgents.length ? 'Select agent' : 'Load a scenario to choose'}
            </option>
            {scenarioAgents.map((id) => (
              <option key={id} value={id}>{id}</option>
            ))}
          </select>
          {selectedCounterpartAgentId && (
            <p className="text-xs text-gray-500 mt-1">Counterpart agent: {selectedCounterpartAgentId}</p>
          )}
        </div>
      </div>

      {/* Enabled Tools */}
      <div className="p-4 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center justify-between mb-2">
          <h4 className="text-sm font-semibold text-gray-800">Enabled Tools (from scenario)</h4>
          {!tools.length && (
            <span className="text-xs text-gray-500">No synthesis tools defined for this agent</span>
          )}
        </div>
        {tools.length > 0 && (
          <div className="grid md:grid-cols-2 grid-cols-1 gap-2">
            {tools.map((t) => {
              const id = `tool-${t.name}`;
              const checked = enabledTools.includes(t.name);
              return (
                <label key={t.name} htmlFor={id} className="flex items-start gap-2 p-2 bg-white rounded border border-gray-200 cursor-pointer">
                  <input
                    id={id}
                    type="checkbox"
                    checked={checked}
                    onChange={(e) => onToggleTool(t.name, e.target.checked)}
                    className="mt-1"
                  />
                  <div>
                    <div className="text-sm font-medium text-gray-800">{t.name}</div>
                    {t.description && <div className="text-xs text-gray-600">{t.description}</div>}
                  </div>
                </label>
              );
            })}
          </div>
        )}
      </div>

      {/* Planner Model */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Planner Model</label>
        <ModelSelect
          providers={providers}
          value={selectedModel}
          onChange={onSelectedModelChange}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Additional Instructions for Your Agent (optional)</label>
        <textarea
          rows={6}
          value={instructions}
          onChange={(e) => onInstructionsChange(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y"
          placeholder="Any extra guidance to add to the scenario-driven prompt"
        />
      </div>

      {attachments && (
        <AttachmentBar
          vault={attachments.vault}
          onFilesSelect={attachments.onFilesSelect}
          onAnalyze={attachments.onAnalyze}
          onOpenAttachment={attachments.onOpenAttachment}
          summarizeOnUpload={useAppStore.getState().attachments.summarizeOnUpload}
          onToggleSummarize={(on) => store.actions.toggleSummarizeOnUpload(on)}
        />
      )}

      <div className="flex items-center gap-4 p-4 bg-gray-50 rounded-lg">
        <div>
          {!plannerStarted ? (
            <Button
              variant="primary"
              size="lg"
              className="px-6 py-3 text-lg rounded-full shadow-lg ring-2 ring-indigo-300"
              onClick={onStartPlanner}
              disabled={!connected}
              title={!connected ? "Not connected" : "Start agent"}
            >
              Start Agent
            </Button>
          ) : (
            <Button
              variant="ghost"
              size="lg"
              className="px-6 py-3 text-lg rounded-full shadow-lg ring-2 ring-indigo-300"
              onClick={onStopPlanner}
            >
              Stop Agent
            </Button>
          )}
        </div>
        <div>
          <p className="text-sm font-medium text-gray-700">
            {plannerStarted ? "Agent is running" : "Agent is not running"}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {plannerStarted
              ? "Your agent is actively managing the conversation"
              : "Activate your agent to begin the conversation"}
          </p>
        </div>
      </div>
    </div>
  );
};
