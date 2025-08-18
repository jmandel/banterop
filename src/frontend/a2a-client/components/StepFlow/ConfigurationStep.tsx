import React from "react";
import { Button } from "../../../ui";
import { AttachmentBar } from "../Attachments/AttachmentBar";

type PlannerMode = "passthrough" | "autostart" | "approval";

interface ConfigurationStepProps {
  goals: string;
  onGoalsChange: (value: string) => void;
  instructions: string;
  onInstructionsChange: (value: string) => void;
  plannerMode: PlannerMode;
  onPlannerModeChange: (mode: PlannerMode) => void;
  selectedModel: string;
  onModelChange: (model: string) => void;
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
  goals,
  onGoalsChange,
  instructions,
  onInstructionsChange,
  plannerMode,
  onPlannerModeChange,
  selectedModel,
  onModelChange,
  providers,
  plannerStarted,
  onStartPlanner,
  onStopPlanner,
  connected,
  attachments,
}) => {
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Background & Goals
          </label>
          <textarea
            rows={10}
            value={goals}
            onChange={(e) => onGoalsChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y min-h-[250px]"
            placeholder="Context/Background & Goals:
- Paste relevant background and end goals here.
- The planner may lead, optionally asking before the first send per policy."
          />
        </div>
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Planner Instructions
          </label>
          <textarea
            rows={10}
            value={instructions}
            onChange={(e) => onInstructionsChange(e.target.value)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-y min-h-[250px]"
            placeholder="Primary goal: help the user accomplish their task with minimal back-and-forth."
          />
        </div>
      </div>

      {/* Moved Attachments inside the planner box, above planner mode */}
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

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">
            Planner Mode
          </label>
          <select
            value={plannerMode}
            onChange={(e) => onPlannerModeChange(e.target.value as PlannerMode)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            disabled={plannerStarted}
          >
            <option value="passthrough">Passthrough - Direct bridging to agent</option>
            <option value="autostart">Autostart - Planner initiates automatically</option>
            <option value="approval">Approval - Wait for user before starting</option>
          </select>
        </div>

        {plannerMode !== "passthrough" && (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Planner Model
            </label>
            <select
              value={selectedModel}
              onChange={(e) => onModelChange(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            >
              {providers.map((p) => (
                <optgroup key={p.name} label={p.name}>
                  {(p.models || []).map((m) => (
                    <option key={`${p.name}:${m}`} value={m}>
                      {m}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
        )}
      </div>

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
