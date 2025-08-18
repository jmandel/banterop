import React from "react";
import { ConnectionStep } from "./ConnectionStep";
import { ConfigurationStep } from "./ConfigurationStep";
// ConversationStep removed - input is now in DualConversationView
import type { A2AStatus } from "../../a2a-types";

type PlannerMode = "passthrough" | "autostart" | "approval";
type FrontMsg = { id: string; role: "you" | "planner" | "system"; text: string };

interface StepFlowProps {
  // Connection props
  endpoint: string;
  onEndpointChange: (value: string) => void;
  status: A2AStatus | "initializing";
  taskId?: string;
  connected: boolean;
  error?: string;
  card?: any;
  cardLoading?: boolean;
  onCancelTask: () => void;
  
  // Configuration props
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
  
  // Scenario loading
  onLoadScenario?: (goals: string, instructions: string) => void;

  // Attachments (moved inside planner configuration)
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

export const StepFlow: React.FC<StepFlowProps> = (props) => {
  const getStepStyles = (stepNum: number) => {
    // Determine status based on state
    if (stepNum === 1 && props.connected) {
      return "bg-gradient-to-br from-green-50 to-emerald-50 border-green-400";
    } else if (stepNum === 2 && props.plannerStarted) {
      return "bg-gradient-to-br from-green-50 to-emerald-50 border-green-400";
    } else if (stepNum === 3 && props.plannerStarted) {
      return "bg-gradient-to-br from-indigo-50 to-blue-50 border-indigo-400";
    } else if (stepNum === 1 || (stepNum === 2 && props.connected) || (stepNum === 3 && props.plannerStarted)) {
      return "bg-white border-gray-300";
    }
    return "bg-gray-50 border-gray-200 opacity-60";
  };

  const getStepIcon = (stepNum: number) => {
    if (stepNum === 1 && props.connected) {
      return (
        <div className="w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </div>
      );
    } else if (stepNum === 2 && props.plannerStarted) {
      return (
        <div className="w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </div>
      );
    } else if ((stepNum === 1) || (stepNum === 2 && props.connected) || (stepNum === 3 && props.plannerStarted)) {
      return (
        <div className="w-8 h-8 rounded-full bg-indigo-500 text-white flex items-center justify-center font-bold">
          {stepNum}
        </div>
      );
    }
    return (
      <div className="w-8 h-8 rounded-full bg-gray-300 text-gray-600 flex items-center justify-center font-bold">
        {stepNum}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      {/* Step 1: Connect */}
      <div className={`rounded-xl border-2 p-6 transition-all duration-300 ${getStepStyles(1)}`}>
        <div className="flex items-start gap-4 mb-4">
          {getStepIcon(1)}
          <div className="flex-1">
            <h3 className="text-lg font-bold text-gray-900">Step 1: Connect to Agent</h3>
            <p className="text-sm text-gray-600 mt-1">
              {props.connected ? "✓ Connected successfully" : "Enter your A2A endpoint URL"}
            </p>
          </div>
        </div>
        <div className="pl-12">
          <ConnectionStep
            endpoint={props.endpoint}
            onEndpointChange={props.onEndpointChange}
            status={props.status}
            taskId={props.taskId}
            connected={props.connected}
            error={props.error}
            card={props.card}
            cardLoading={props.cardLoading}
            onCancelTask={props.onCancelTask}
            goals={props.goals}
            instructions={props.instructions}
            onLoadScenario={props.onLoadScenario}
          />
        </div>
      </div>

      {/* Step 2: Configure */}
      <div className={`rounded-xl border-2 p-6 transition-all duration-300 ${getStepStyles(2)}`}>
        <div className="flex items-start gap-4 mb-4">
          {getStepIcon(2)}
          <div className="flex-1">
            <h3 className="text-lg font-bold text-gray-900">Step 2: Configure Planner</h3>
            <p className="text-sm text-gray-600 mt-1">
              {props.plannerStarted ? "✓ Planner is running" : props.connected ? "Set up your planner preferences" : "Connect first to configure"}
            </p>
          </div>
        </div>
        <div className="pl-12">
        <ConfigurationStep
          goals={props.goals}
          onGoalsChange={props.onGoalsChange}
          instructions={props.instructions}
          onInstructionsChange={props.onInstructionsChange}
          plannerMode={props.plannerMode}
          onPlannerModeChange={props.onPlannerModeChange}
          selectedModel={props.selectedModel}
          onModelChange={props.onModelChange}
          providers={props.providers}
          plannerStarted={props.plannerStarted}
          onStartPlanner={props.onStartPlanner}
          onStopPlanner={props.onStopPlanner}
          connected={props.connected}
          attachments={props.attachments}
        />
        </div>
      </div>

      {/* Step 3 removed - conversation input is now in the conversation panels */}
    </div>
  );
};
