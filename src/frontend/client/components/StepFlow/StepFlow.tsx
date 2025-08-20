import React from "react";
import { ConnectionStep } from "./ConnectionStep";
import { ConfigurationStep } from "./ConfigurationStep";
// ConversationStep removed - input is now in DualConversationView
import type { A2AStatus } from "../../a2a-types";
import { useAppStore } from "$src/frontend/client/stores/appStore";
type FrontMsg = { id: string; role: "you" | "planner" | "system"; text: string };

interface StepFlowProps {
  // Connection props
  endpoint?: string;
  onEndpointChange?: (value: string) => void;
  protocol?: "auto" | "a2a" | "mcp";
  onProtocolChange?: (p: "auto" | "a2a" | "mcp") => void;
  status?: A2AStatus | "initializing";
  taskId?: string;
  connected?: boolean;
  error?: string;
  card?: any;
  cardLoading?: boolean;
  onCancelTask?: () => void;
  
  // Configuration props
  instructions?: string;
  onInstructionsChange?: (value: string) => void;
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
  };
}

export const StepFlow: React.FC<StepFlowProps> = (props) => {
  const store = useAppStore();
  const endpoint = store.connection.endpoint ?? "";
  const protocol = store.connection.protocol ?? "auto";
  const status = store.task.status ?? props.status ?? "initializing";
  const taskId = store.task.id ?? props.taskId;
  const connected = (store.connection.status === 'connected');
  const plannerStarted = store.planner.started ?? props.plannerStarted ?? false;
  const error = store.connection.error ?? props.error;
  const card = store.connection.card ?? props.card;
  const instructions = store.planner.instructions ?? "";
  const selectedModel = store.planner.model ?? "";
  const onEndpointChange = props.onEndpointChange ?? ((v: string) => store.actions.setEndpoint(v));
  const onProtocolChange = props.onProtocolChange ?? ((p: any) => store.actions.setProtocol(p));
  const onCancelTask = props.onCancelTask ?? (() => store.actions.cancelTask());
  const onStartPlanner = props.onStartPlanner ?? (() => store.actions.startPlanner());
  const onStopPlanner = props.onStopPlanner ?? (() => store.actions.stopPlanner());
  const onInstructionsChange = props.onInstructionsChange ?? ((v: string) => store.actions.setInstructions(v));

  const getStepStyles = (stepNum: number) => {
    // Determine status based on state
    if (stepNum === 1 && connected) {
      return "bg-gradient-to-br from-green-50 to-emerald-50 border-green-400";
    } else if (stepNum === 2 && plannerStarted) {
      return "bg-gradient-to-br from-green-50 to-emerald-50 border-green-400";
    } else if (stepNum === 3 && plannerStarted) {
      return "bg-gradient-to-br from-indigo-50 to-blue-50 border-indigo-400";
    } else if (stepNum === 1 || (stepNum === 2 && connected) || (stepNum === 3 && plannerStarted)) {
      return "bg-white border-gray-300";
    }
    return "bg-gray-50 border-gray-200 opacity-60";
  };

  const getStepIcon = (stepNum: number) => {
    if (stepNum === 1 && connected) {
      return (
        <div className="w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </div>
      );
    } else if (stepNum === 2 && plannerStarted) {
      return (
        <div className="w-8 h-8 rounded-full bg-green-500 text-white flex items-center justify-center">
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
          </svg>
        </div>
      );
    } else if ((stepNum === 1) || (stepNum === 2 && connected) || (stepNum === 3 && plannerStarted)) {
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
            <h3 className="text-lg font-bold text-gray-900">Step 1: Configure Remote Agent</h3>
            <p className="text-sm text-gray-600 mt-1">
              {props.connected ? "✓ Connected successfully" : "Enter your endpoint URL and protocol"}
            </p>
          </div>
        </div>
        <div className="pl-12">
          <ConnectionStep
            card={card}
            cardLoading={props.cardLoading}
            onLoadScenario={props.onLoadScenario}
            onCancelTask={props.onCancelTask}
          />
        </div>
      </div>

      {/* Step 2: Configure */}
      <div className={`rounded-xl border-2 p-6 transition-all duration-300 ${getStepStyles(2)}`}>
        <div className="flex items-start gap-4 mb-4">
          {getStepIcon(2)}
          <div className="flex-1">
            <h3 className="text-lg font-bold text-gray-900">Step 2: Configure Your Agent</h3>
            <p className="text-sm text-gray-600 mt-1">{props.plannerStarted ? "✓ Agent is running" : props.connected ? "Set up your agent" : "Connect first to configure"}</p>
          </div>
        </div>
        <div className="pl-12">
        <ConfigurationStep
          scenarioUrl={props.scenarioUrl ?? store.scenario.url ?? ""}
          onScenarioUrlChange={props.onScenarioUrlChange}
          onLoadScenarioUrl={props.onLoadScenarioUrl}
          providers={props.providers ?? []}
          attachments={props.attachments}
        />
        </div>
      </div>

      {/* Step 3 removed - conversation input is now in the conversation panels */}
    </div>
  );
};
