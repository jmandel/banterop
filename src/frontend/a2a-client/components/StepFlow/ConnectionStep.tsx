import React from "react";
import { Button, Badge } from "../../../ui";
import type { A2AStatus } from "../../a2a-types";
import { ScenarioDetector } from "./ScenarioDetector";

interface ConnectionStepProps {
  endpoint: string;
  onEndpointChange: (value: string) => void;
  status: A2AStatus | "initializing";
  taskId?: string;
  connected: boolean;
  error?: string;
  card?: any;
  cardLoading?: boolean;
  onCancelTask: () => void;
  onLoadScenario?: (goals: string, instructions: string) => void;
}

export const ConnectionStep: React.FC<ConnectionStepProps> = ({
  endpoint,
  onEndpointChange,
  status,
  taskId,
  connected,
  error,
  card,
  cardLoading,
  onCancelTask,
  onLoadScenario,
}) => {
  const getStatusPill = () => {
    const map: Record<A2AStatus | "initializing", { label: string; className: string }> = {
      initializing: { label: "initializing…", className: "bg-gray-100 text-gray-700" },
      submitted: { label: "submitted", className: "bg-blue-100 text-blue-700" },
      working: { label: "working…", className: "bg-yellow-100 text-yellow-700" },
      "input-required": { label: "your turn", className: "bg-orange-100 text-orange-700" },
      completed: { label: "completed", className: "bg-green-100 text-green-700" },
      failed: { label: "failed", className: "bg-red-100 text-red-700" },
      canceled: { label: "canceled", className: "bg-gray-100 text-gray-700" },
    };
    const m = map[status];
    return (
      <span className={`px-2 py-1 rounded-full text-xs font-medium ${m.className}`}>
        {m.label}
      </span>
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          A2A Endpoint URL
        </label>
        <input
          type="text"
          value={endpoint}
          onChange={(e) => onEndpointChange(e.target.value)}
          placeholder="http://localhost:3000/api/bridge/<config64>/a2a"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-sm text-gray-600">Status:</span>
          {getStatusPill()}
          {taskId && (
            <>
              <span className="text-sm text-gray-600">• Task:</span>
              <Badge>{taskId}</Badge>
            </>
          )}
        </div>
        <Button
          variant="secondary"
          onClick={onCancelTask}
          disabled={!taskId}
        >
          Cancel Task
        </Button>
      </div>

      {connected && (
        <div className="p-3 bg-gray-50 rounded-lg">
          {cardLoading ? (
            <p className="text-sm text-gray-500">Fetching agent card…</p>
          ) : card?.error ? (
            <p className="text-sm text-red-600">Agent card error: {card.error}</p>
          ) : card ? (
            <div>
              <p className="text-sm text-gray-700">
                Connected to{" "}
                <span className="font-mono bg-white px-1 py-0.5 rounded">
                  {card.name || "A2A Endpoint"}
                </span>
              </p>
              {card.description && (
                <p className="text-sm text-gray-600 mt-1">{card.description}</p>
              )}
            </div>
          ) : null}
        </div>
      )}

      {error && (
        <div className="p-3 bg-red-50 rounded-lg">
          <p className="text-sm text-red-600">Error: {error}</p>
        </div>
      )}

      {onLoadScenario && (
        <ScenarioDetector
          endpoint={endpoint}
          onLoadScenario={onLoadScenario}
        />
      )}
      
      <div className="p-3 bg-blue-50 rounded-lg">
        <p className="text-xs text-blue-700">
          Endpoint URL is auto-saved and will connect automatically when changed
        </p>
      </div>
    </div>
  );
};