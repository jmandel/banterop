import React from "react";
import { Button } from "../../../ui";
import { AttachmentBar } from "../Attachments/AttachmentBar";

interface ConfigurationStepProps {
  instructions: string;
  onInstructionsChange: (value: string) => void;
  // Scenario configuration (URL + agent selection)
  scenarioUrl: string;
  onScenarioUrlChange: (value: string) => void;
  onLoadScenarioUrl?: () => void;
  scenarioAgents: string[];
  selectedPlannerAgentId?: string;
  onSelectPlannerAgentId: (id: string) => void;
  selectedCounterpartAgentId?: string;
  tools: Array<{ name: string; description?: string }>;
  enabledTools: string[];
  onToggleTool: (name: string, enabled: boolean) => void;
  providers: Array<{ name: string; models: string[] }>;
  plannerStarted: boolean;
  onStartPlanner: () => void;
  onStopPlanner: () => void;
  connected: boolean;
  // Attachments
  attachments?: {
    vault: import("../../attachments-vault").AttachmentVault;
    onFilesSelect: (files: FileList | null) => void;
    onAnalyze: (name: string) => void;
    onOpenAttachment?: (name: string, mimeType: string, bytes?: string, uri?: string) => void;
    summarizeOnUpload: boolean;
    onToggleSummarize: (value: boolean) => void;
    summarizerModel: string;
    onSummarizerModelChange: (model: string) => void;
  };
}

export const ConfigurationStep: React.FC<ConfigurationStepProps> = ({
  instructions,
  onInstructionsChange,
  scenarioUrl,
  onScenarioUrlChange,
  onLoadScenarioUrl,
  scenarioAgents,
  selectedPlannerAgentId,
  onSelectPlannerAgentId,
  selectedCounterpartAgentId,
  tools,
  enabledTools,
  onToggleTool,
  providers,
  plannerStarted,
  onStartPlanner,
  onStopPlanner,
  connected,
  attachments,
}) => {
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
          <p className="text-xs text-gray-500 mt-1">Paste a scenario endpoint to drive planner context.</p>
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Planner Agent</label>
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

      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">Additional Planner Instructions (optional)</label>
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
          summarizeOnUpload={attachments.summarizeOnUpload}
          onToggleSummarize={attachments.onToggleSummarize}
          summarizerModel={attachments.summarizerModel}
          onSummarizerModelChange={attachments.onSummarizerModelChange}
          providers={providers}
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
              title={!connected ? "Not connected" : "Start planner"}
            >
              Begin Planner
            </Button>
          ) : (
            <Button variant="ghost" onClick={onStopPlanner}>
              Stop Planner
            </Button>
          )}
        </div>
        <div>
          <p className="text-sm font-medium text-gray-700">
            {plannerStarted ? "Planner is running" : "Planner is not running"}
          </p>
          <p className="text-xs text-gray-500 mt-1">
            {plannerStarted
              ? "The planner is actively managing the conversation"
              : "Start the planner to begin the conversation workflow"}
          </p>
        </div>
      </div>
    </div>
  );
};
