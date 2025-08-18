import React, { useState, useEffect } from "react";
import { StepContainer, StepStatus } from "./StepContainer";
import { ConnectionStep } from "./ConnectionStep";
import { ConfigurationStep } from "./ConfigurationStep";
import { ConversationStep } from "./ConversationStep";
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
  
  // Conversation props
  messages: FrontMsg[];
  input: string;
  onInputChange: (value: string) => void;
  onSendMessage: (text: string) => void;
  busy: boolean;
}

export const StepFlow: React.FC<StepFlowProps> = (props) => {
  const [expandedStep, setExpandedStep] = useState<number>(1);
  
  // Determine step statuses based on state
  const getStepStatus = (step: number): StepStatus => {
    switch (step) {
      case 1: // Connection
        if (props.connected) return "complete";
        return expandedStep === 1 ? "active" : "pending";
      
      case 2: // Configuration
        if (props.plannerStarted) return "complete";
        if (props.connected) return expandedStep === 2 ? "active" : "pending";
        return "pending";
      
      case 3: // Conversation
        if (props.status === "completed") return "complete";
        if (props.plannerStarted) return "active";
        return "pending";
      
      default:
        return "pending";
    }
  };
  
  // Auto-expand appropriate step based on state
  useEffect(() => {
    if (!props.connected) {
      setExpandedStep(1);
    } else if (!props.plannerStarted) {
      setExpandedStep(2);
    } else {
      setExpandedStep(3);
    }
  }, [props.connected, props.plannerStarted]);
  
  return (
    <div className="space-y-4">
      {/* Step 1: Connect */}
      <StepContainer
        stepNumber={1}
        title="Connect to Agent"
        status={getStepStatus(1)}
        isExpanded={expandedStep === 1}
        onToggle={() => setExpandedStep(expandedStep === 1 ? 0 : 1)}
      >
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
        />
      </StepContainer>
      
      {/* Step 2: Configure */}
      <StepContainer
        stepNumber={2}
        title="Configure Planner"
        status={getStepStatus(2)}
        isExpanded={expandedStep === 2}
        onToggle={() => setExpandedStep(expandedStep === 2 ? 0 : 2)}
      >
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
        />
      </StepContainer>
      
      {/* Step 3: Converse */}
      <StepContainer
        stepNumber={3}
        title="Converse"
        status={getStepStatus(3)}
        isExpanded={expandedStep === 3}
        onToggle={() => setExpandedStep(expandedStep === 3 ? 0 : 3)}
      >
        <ConversationStep
          messages={props.messages}
          input={props.input}
          onInputChange={props.onInputChange}
          onSendMessage={props.onSendMessage}
          plannerStarted={props.plannerStarted}
          connected={props.connected}
          busy={props.busy}
        />
      </StepContainer>
    </div>
  );
};
