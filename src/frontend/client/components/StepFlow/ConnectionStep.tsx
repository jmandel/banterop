import React, { useMemo } from "react";
import { Button, Badge } from "../../../ui";
import type { A2AStatus } from "../../a2a-types";
import { parseBridgeEndpoint } from "../../bridge-endpoint";
import { useAppStore } from "$src/frontend/client/stores/appStore";
import { detectProtocolFromUrl } from "../../protocols";

interface ConnectionStepProps {
  // session removed; reads from store
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
  onLoadScenario?: (goals: string, instructions: string) => void;
  goals?: string;
  instructions?: string;
}

export const ConnectionStep: React.FC<ConnectionStepProps> = ({
  endpoint: epProp,
  onEndpointChange: onEndpointChangeProp,
  protocol: protoProp,
  onProtocolChange: onProtocolChangeProp,
  status: statusProp,
  taskId: taskIdProp,
  connected: connectedProp,
  error: errorProp,
  card,
  cardLoading,
  onCancelTask: onCancelTaskProp,
  onLoadScenario,
  goals,
  instructions,
}) => {
  const store = useAppStore();
  const controlled = typeof onEndpointChangeProp === 'function';
  const endpoint = controlled
    ? (epProp ?? "")
    : (store.connection.endpoint || store.defaultsFromUrlParameters?.endpoint || epProp || "");
  const protocol = store.connection.protocol ?? protoProp ?? "auto";
  const status = store.task.status ?? statusProp ?? "initializing";
  const taskId = store.task.id ?? taskIdProp;
  const connected = (store.connection.status === 'connected');
  const error = store.connection.error ?? errorProp;
  const onEndpointChange = onEndpointChangeProp ?? ((v: string) => store.actions.setEndpoint(v));
  const onProtocolChange = onProtocolChangeProp ?? ((p: any) => store.actions.setProtocol(p));
  const onCancelTask = onCancelTaskProp ?? (() => { store.actions.cancelTask(); });
  // Detect our reference stack (same logic as ScenarioDetector)
  const canOpenWatch = useMemo(() => {
    try {
      if (!taskId) return false;
      const { isOurs, config64 } = parseBridgeEndpoint(endpoint);
      return !!(isOurs && config64);
    } catch { return false; }
  }, [endpoint, taskId]);

  const watchHref = useMemo(() => {
    try {
      const parsed = parseBridgeEndpoint(endpoint);
      if (!parsed.isOurs || !parsed.serverBase || !taskId) return undefined;
      return `${parsed.serverBase}/watch/#/conversation/${taskId}`;
    } catch { return undefined; }
  }, [endpoint, taskId]);
  const getStatusPill = () => {
    const map: Record<A2AStatus | "initializing", { label: string; className: string }> = {
      initializing: { label: "Not yet started", className: "bg-gray-100 text-gray-700" },
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
          Endpoint URL
        </label>
        <input
          type="text"
          defaultValue={endpoint}
          onChange={(e) => onEndpointChange(e.target.value)}
          placeholder="https://example.org/path/to/(a2a|mcp)"
          className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Protocol</label>
          <select
            value={protocol}
            onChange={(e) => onProtocolChange(e.target.value as any)}
            className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
          >
            <option value="auto">Auto (by URL)</option>
            <option value="a2a">A2A</option>
            <option value="mcp">MCP</option>
          </select>
          <p className="text-xs text-gray-500 mt-1">
            Auto detects by suffix: /a2a or /mcp.
            {(() => {
              const info = store.connection.preview as any;
              const epHasText = (endpoint || '').trim().length > 0;
              if (protocol === 'auto') {
                if (info?.protocol === 'a2a') {
                  const cls = 'text-green-600';
                  const text = info.status === 'connecting'
                    ? 'A2A: connecting'
                    : info.status === 'agent-card'
                      ? 'A2A: agent card fetched'
                      : info.status === 'error'
                        ? `A2A: ${info.error || 'error'}`
                        : 'A2A';
                  return <span className={`ml-2 ${cls}`}>{text}</span>;
                }
                if (info?.protocol === 'mcp') {
                  const cls = 'text-blue-600';
                  const text = info.status === 'connecting'
                    ? 'MCP: connecting'
                    : info.status === 'tools'
                      ? `MCP: tools loaded${Array.isArray(info.tools) ? ` (${info.tools.length})` : ''}`
                      : info.status === 'error'
                        ? `MCP: ${info.error || 'error'}`
                        : 'MCP';
                  return <span className={`ml-2 ${cls}`}>{text}</span>;
                }
                if (epHasText) return <span className="ml-2 text-gray-500">Could not detect</span>;
                return null;
              } else {
                // Explicit selection: prefer service-reported status if present
                if (info?.protocol === protocol) {
                  const cls = protocol === 'a2a' ? 'text-green-600' : 'text-blue-600';
                  const text = protocol === 'a2a'
                    ? (info.status === 'connecting' ? 'A2A: connecting' : info.status === 'agent-card' ? 'A2A: agent card fetched' : info.status === 'error' ? `A2A: ${info.error || 'error'}` : 'A2A')
                    : (info.status === 'connecting' ? 'MCP: connecting' : info.status === 'tools' ? `MCP: tools loaded${Array.isArray(info.tools) ? ` (${info.tools.length})` : ''}` : info.status === 'error' ? `MCP: ${info.error || 'error'}` : 'MCP');
                  return <span className={`ml-2 ${cls}`}>{text}</span>;
                }
                const cls = protocol === 'a2a' ? 'text-green-600' : 'text-blue-600';
                return <span className={`ml-2 ${cls}`}>Using: {protocol} (selected)</span>;
              }
            })()}
          </p>
        </div>
      </div>

      {/* Connect/Disconnect controls and Task Status */}
      <div className="mt-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
        <div className="flex items-center gap-3 flex-wrap">
          {!connected ? (
            <Button
              variant="primary"
              onClick={() => store.actions.connect(endpoint, protocol)}
              className="px-4 py-2"
              disabled={!String(endpoint || '').trim()}
            >
              Connect
            </Button>
          ) : (
            <Button
              variant="secondary"
              onClick={() => store.actions.disconnect()}
              className="px-4 py-2"
            >
              Disconnect
            </Button>
          )}
          {(connected || taskId) && (
            <Button
              variant="primary"
              onClick={onCancelTask}
              className="px-4 py-2"
            >
              Restart Scenario
            </Button>
          )}
          <span className="text-sm font-medium text-gray-700">Task Status:</span>
          {getStatusPill()}
          {taskId && (
            <>
              <span className="text-sm text-gray-600">• Task:</span>
              <Badge>{taskId}</Badge>
            </>
          )}
          {canOpenWatch && watchHref && (
            <a
              className="ml-2 text-sm text-indigo-600 hover:underline"
              href={watchHref}
              target="_blank"
              rel="noreferrer"
              title="Open this task in Watch"
            >
              Open in Watch
            </a>
          )}
        </div>
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
              {card.mcp && (
                <div className="mt-2 text-xs text-gray-700">
                  <div>Tools available: {Array.isArray(card.mcp.toolNames) ? card.mcp.toolNames.length : 0}</div>
                  <div>
                    Required tools: {Array.isArray(card.mcp.required) ? card.mcp.required.join(', ') : ''}
                  </div>
                  {Array.isArray(card.mcp.missing) && card.mcp.missing.length > 0 ? (
                    <div className="text-red-600">Missing: {card.mcp.missing.join(', ')}</div>
                  ) : (
                    <div className="text-green-600">All required tools available</div>
                  )}
                </div>
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

      {/* ScenarioDetector disabled: rely only on explicit scenario URL */}
      
    </div>
  );
};
