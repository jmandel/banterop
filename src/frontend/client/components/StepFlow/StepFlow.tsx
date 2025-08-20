import React from "react";
import { ConnectionStep } from "./ConnectionStep";
import { ConfigurationStep } from "./ConfigurationStep";
// ConversationStep removed - input is now in DualConversationView
import { useAppStore } from "$src/frontend/client/stores/appStore";

export const StepFlow: React.FC = () => {
  const store = useAppStore();
  const endpoint = store.connection.endpoint ?? "";
  const protocol = store.connection.protocol ?? "auto";
  const status = store.task.status ?? "initializing";
  const taskId = store.task.id;
  const connected = (store.connection.status === 'connected');
  const plannerStarted = store.planner.started ?? false;
  const error = store.connection.error;
  const card = store.connection.card;
  const onCancelTask = () => { void store.actions.restartScenario(); };

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
            <p className="text-sm text-gray-600 mt-1">{connected ? "✓ Connected successfully" : "Enter your endpoint URL and protocol"}</p>
          </div>
        </div>
        <div className="pl-12">
          <ConnectionStep card={card} onCancelTask={onCancelTask} />
        </div>
      </div>

      {/* Step 2: Configure */}
      <div className={`rounded-xl border-2 p-6 transition-all duration-300 ${getStepStyles(2)}`}>
        <div className="flex items-start gap-4 mb-4">
          {getStepIcon(2)}
          <div className="flex-1">
            <h3 className="text-lg font-bold text-gray-900">Step 2: Configure Your Agent</h3>
            <p className="text-sm text-gray-600 mt-1">{plannerStarted ? "✓ Agent is running" : connected ? "Set up your agent" : "Connect first to configure"}</p>
          </div>
        </div>
        <div className="pl-12">
        <ConfigurationStep />
        </div>
      </div>

      {/* Step 3 removed - conversation input is now in the conversation panels */}
    </div>
  );
};
