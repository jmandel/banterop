// Real-time Conversation Monitor - React App
import React, { useState, useEffect, useRef, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import type { ConversationState, Turn, ExecutionTrace, TraceStep } from '$lib/types.js';

// Utility function to generate unique IDs
const generateId = () => `client_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

// Custom hook for WebSocket-based conversation monitoring
function useMonitorWebSocket() {
  const [socket, setSocket] = useState<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);
  const [activeRuns, setActiveRuns] = useState<Array<{runId: string, agents: string[]}>>([]);
  const [conversationStates, setConversationStates] = useState<Map<string, ConversationState>>(new Map());
  const clientIdRef = useRef(generateId());

  useEffect(() => {
    const wsUrl = `ws://localhost:3001/monitor-ws?clientId=${clientIdRef.current}`;
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      setConnected(true);
      setSocket(ws);
      console.log('[Monitor] Connected to WebSocket');
    };

    ws.onmessage = (event) => {
      try {
        const message = JSON.parse(event.data);
        handleWebSocketMessage(message);
      } catch (error) {
        console.error('[Monitor] Failed to parse message:', error);
      }
    };

    ws.onclose = () => {
      setConnected(false);
      setSocket(null);
      console.log('[Monitor] Disconnected from WebSocket');
      
      // Auto-reconnect after 3 seconds
      setTimeout(() => {
        if (!connected) {
          console.log('[Monitor] Attempting to reconnect...');
          // Trigger re-render to restart connection
          setConnected(false);
        }
      }, 3000);
    };

    ws.onerror = (error) => {
      console.error('[Monitor] WebSocket error:', error);
    };

    return () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close();
      }
    };
  }, [connected]); // Add connected to deps for auto-reconnect

  const handleWebSocketMessage = (message: any) => {
    switch (message.type) {
      case 'run_list':
      case 'run_created':
        setActiveRuns(message.payload.runs || []);
        break;

      case 'conversation_state':
        setConversationStates(prev => {
          const newMap = new Map(prev);
          newMap.set(message.payload.runId, message.payload.state);
          return newMap;
        });
        break;

      case 'agent_triggered':
        console.log(`[Monitor] Agent ${message.payload.role} triggered in run ${message.payload.runId}`);
        break;

      case 'error':
        console.error('[Monitor] Server error:', message.payload.message);
        break;
    }
  };

  const subscribeToRun = (runId: string) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'subscribe_run',
        payload: { runId }
      }));
    }
  };

  const unsubscribeFromRun = (runId: string) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'unsubscribe_run',
        payload: { runId }
      }));
    }
    setConversationStates(prev => {
      const newMap = new Map(prev);
      newMap.delete(runId);
      return newMap;
    });
  };

  const triggerAgent = (runId: string, role: string) => {
    if (socket && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({
        type: 'trigger_agent',
        payload: { runId, role }
      }));
    }
  };

  const createRun = async (scenarioId: string) => {
    try {
      // Get scenario to build agent configs
      const scenarioResponse = await fetch(`http://localhost:3001/api/scenarios/${scenarioId}`);
      if (!scenarioResponse.ok) {
        console.error('[Monitor] Failed to fetch scenario:', await scenarioResponse.text());
        return null;
      }
      
      const scenario = await scenarioResponse.json();
      
      // Build CreateConversationRequest with ScenarioDrivenAgentConfig
      const conversationRequest = {
        name: `${scenario.name} - Conversation`,
        agents: [
          {
            agentId: {
              id: generateId(),
              label: scenario.config?.patientAgent?.principalIdentity || 'Patient',
              role: 'PatientAgent'
            },
            strategyType: 'scenario_driven',
            scenarioId: scenarioId,
            role: 'PatientAgent'
          },
          {
            agentId: {
              id: generateId(),
              label: scenario.config?.supplierAgent?.principalIdentity || 'Supplier',
              role: 'SupplierAgent'
            },
            strategyType: 'scenario_driven',
            scenarioId: scenarioId,
            role: 'SupplierAgent'
          }
        ],
        initialMessage: {
          agentId: 'patient-agent-id', // Will be replaced with actual agent ID
          content: scenario.config?.interactionDynamics?.startingPoints?.PatientAgent?.objective || 'Hello, I need assistance.'
        }
      };
      
      // Set the correct initial message agent ID
      conversationRequest.initialMessage.agentId = conversationRequest.agents[0].agentId.id;
      
      const response = await fetch('http://localhost:3001/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(conversationRequest)
      });
      
      if (response.ok) {
        const data = await response.json();
        console.log(`[Monitor] Created conversation ${data.conversation.id}`);
        return data.conversation.id;
      } else {
        console.error('[Monitor] Failed to create conversation:', await response.text());
      }
    } catch (error) {
      console.error('[Monitor] Error creating conversation:', error);
    }
    return null;
  };

  return {
    connected,
    activeRuns,
    conversationStates,
    subscribeToRun,
    unsubscribeFromRun,
    triggerAgent,
    createRun
  };
}

// Component for displaying a single conversation turn
function TurnBubble({ turn, isLatest, onClick }: { 
  turn: Turn; 
  isLatest: boolean; 
  onClick?: () => void; 
}) {
  const textContent = turn.content.find(c => c.type === 'text')?.text || '';
  const dataContent = turn.content.find(c => c.type === 'data')?.data;
  
  const getBubbleColor = (role: string, kind: string) => {
    if (kind === 'user_query') return 'bg-yellow-100 border-yellow-300';
    if (kind === 'user_response') return 'bg-green-100 border-green-300';
    if (role === 'PatientAgent') return 'bg-blue-100 border-blue-300';
    if (role === 'SupplierAgent') return 'bg-purple-100 border-purple-300';
    return 'bg-gray-100 border-gray-300';
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  return (
    <div 
      className={`p-3 rounded-lg border-2 cursor-pointer transition-all ${getBubbleColor(turn.role, turn.kind)} ${
        isLatest ? 'ring-2 ring-blue-400' : ''
      } ${turn.traceId ? 'hover:shadow-md' : ''}`}
      onClick={onClick}
    >
      <div className="flex justify-between items-start mb-2">
        <div className="flex items-center gap-2">
          <RoleBadge role={turn.role} />
          <span className="text-xs text-gray-500 capitalize">{turn.kind}</span>
        </div>
        <span className="text-xs text-gray-400">{formatTimestamp(turn.timestamp)}</span>
      </div>
      
      {textContent && (
        <p className="text-sm text-gray-800 mb-2">{textContent}</p>
      )}
      
      {dataContent && (
        <details className="text-xs">
          <summary className="cursor-pointer text-gray-600">Data</summary>
          <pre className="mt-2 text-xs bg-gray-50 p-2 rounded overflow-x-auto">
            {JSON.stringify(dataContent, null, 2)}
          </pre>
        </details>
      )}
      
      {turn.traceId && (
        <div className="mt-2 text-xs text-blue-600">
          📊 Has execution trace - click to inspect
        </div>
      )}
    </div>
  );
}

// Component for role badges
function RoleBadge({ role }: { role: string }) {
  const getBadgeColor = (role: string) => {
    if (role === 'PatientAgent') return 'bg-blue-500';
    if (role === 'SupplierAgent') return 'bg-purple-500';
    if (role === 'human') return 'bg-green-500';
    return 'bg-gray-500';
  };

  return (
    <span className={`px-2 py-1 rounded text-xs text-white font-medium ${getBadgeColor(role)}`}>
      {role}
    </span>
  );
}

// Component for manual agent triggering
function AgentTrigger({ runId, agents, onTrigger }: { 
  runId: string; 
  agents: string[]; 
  onTrigger: (runId: string, role: string) => void; 
}) {
  const [selectedAgent, setSelectedAgent] = useState(agents[0] || '');
  const [triggering, setTriggering] = useState(false);

  const handleTrigger = async () => {
    if (!selectedAgent) return;
    
    setTriggering(true);
    onTrigger(runId, selectedAgent);
    
    // Reset after delay
    setTimeout(() => setTriggering(false), 1000);
  };

  return (
    <div className="flex gap-2 items-center">
      <select 
        value={selectedAgent}
        onChange={(e) => setSelectedAgent(e.target.value)}
        className="px-2 py-1 border rounded text-sm"
        disabled={triggering}
      >
        {agents.map(agent => (
          <option key={agent} value={agent}>{agent}</option>
        ))}
      </select>
      <button
        onClick={handleTrigger}
        disabled={triggering || !selectedAgent}
        className="px-3 py-1 bg-green-500 text-white rounded text-sm disabled:opacity-50 hover:bg-green-600"
      >
        {triggering ? 'Triggering...' : 'Trigger'}
      </button>
    </div>
  );
}

// Component for displaying execution traces
function TraceInspector({ trace, runId }: { trace: ExecutionTrace | null; runId: string }) {
  const [expandedSteps, setExpandedSteps] = useState<Set<string>>(new Set());

  const toggleStep = (stepId: string) => {
    setExpandedSteps(prev => {
      const newSet = new Set(prev);
      if (newSet.has(stepId)) {
        newSet.delete(stepId);
      } else {
        newSet.add(stepId);
      }
      return newSet;
    });
  };

  const getStepIcon = (type: string) => {
    switch (type) {
      case 'thought': return '🤔';
      case 'tool_call': return '🔧';
      case 'tool_result': return '📋';
      case 'synthesis': return '✨';
      default: return '•';
    }
  };

  const getStepColor = (type: string) => {
    switch (type) {
      case 'thought': return 'border-l-blue-500';
      case 'tool_call': return 'border-l-green-500';
      case 'tool_result': return 'border-l-red-500';
      case 'synthesis': return 'border-l-purple-500';
      default: return 'border-l-gray-500';
    }
  };

  if (!trace) {
    return (
      <div className="p-4 text-center text-gray-500">
        <p>Select a turn with a trace to inspect execution steps</p>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b">
        <h3 className="font-semibold text-lg">Execution Trace</h3>
        <p className="text-sm text-gray-600">
          Turn: {trace.turnId} | Steps: {trace.steps.length}
        </p>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-3">
        {trace.steps.map((step, index) => (
          <div 
            key={step.id}
            className={`border-l-4 pl-4 py-2 cursor-pointer ${getStepColor(step.type)}`}
            onClick={() => toggleStep(step.id)}
          >
            <div className="flex items-center gap-2 mb-1">
              <span className="text-lg">{getStepIcon(step.type)}</span>
              <span className="font-medium text-sm">{step.label}</span>
              <span className="text-xs text-gray-500">#{index + 1}</span>
            </div>
            
            {step.detail && (
              <p className="text-sm text-gray-700 mb-2">{step.detail}</p>
            )}
            
            {step.data && expandedSteps.has(step.id) && (
              <pre className="text-xs bg-gray-50 p-2 rounded overflow-x-auto">
                {JSON.stringify(step.data, null, 2)}
              </pre>
            )}
            
            <div className="text-xs text-gray-400">
              {new Date(step.timestamp).toLocaleTimeString()}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// Component for live conversation view
function LiveConversation({ runId, state, onSelectTrace }: { 
  runId: string; 
  state: ConversationState; 
  onSelectTrace: (trace: ExecutionTrace | null) => void; 
}) {
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && bottomRef.current) {
      bottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [state.turns.length, autoScroll]);

  const handleTurnClick = (turn: Turn) => {
    if (turn.traceId && state.traces[turn.traceId]) {
      onSelectTrace(state.traces[turn.traceId!] || null);
    }
  };

  return (
    <div className="h-full flex flex-col">
      <div className="p-4 border-b bg-white flex justify-between items-center">
        <div>
          <h3 className="font-semibold">Run: {runId}</h3>
          <p className="text-sm text-gray-600">
            {state.turns.length} turns | Version: {state.version}
          </p>
        </div>
        <button
          onClick={() => setAutoScroll(!autoScroll)}
          className={`px-3 py-1 rounded text-sm ${
            autoScroll ? 'bg-blue-500 text-white' : 'bg-gray-200 text-gray-700'
          }`}
        >
          Auto-scroll: {autoScroll ? 'ON' : 'OFF'}
        </button>
      </div>
      
      <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-gray-50">
        {state.turns.length === 0 ? (
          <div className="text-center text-gray-500 py-8">
            <p>No conversation turns yet</p>
            <p className="text-sm">Conversation will appear here in real-time</p>
          </div>
        ) : (
          state.turns.map((turn, index) => (
            <TurnBubble
              key={turn.id}
              turn={turn}
              isLatest={index === state.turns.length - 1}
              onClick={() => handleTurnClick(turn)}
            />
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

// Component for creating new runs with scenario selection
function CreateRunButton({ onCreateRun }: { onCreateRun: (scenarioId: string) => void }) {
  const [creating, setCreating] = useState(false);
  const [scenarios, setScenarios] = useState<Array<{id: string, name: string}>>([]);
  const [selectedScenarioId, setSelectedScenarioId] = useState<string>('');
  const [loading, setLoading] = useState(true);
  
  // Load scenarios on mount
  useEffect(() => {
    const loadScenarios = async () => {
      try {
        const response = await fetch('http://localhost:3001/api/scenarios');
        const data = await response.json();
        if (data.success) {
          const scenarioList = data.data.scenarios.map((s: any) => ({
            id: s.id,
            name: s.name
          }));
          setScenarios(scenarioList);
          // Auto-select first scenario if available
          if (scenarioList.length > 0) {
            setSelectedScenarioId(scenarioList[0].id);
          }
        }
      } catch (error) {
        console.error('Failed to load scenarios:', error);
      } finally {
        setLoading(false);
      }
    };
    
    loadScenarios();
  }, []);
  
  const handleCreate = async () => {
    if (!selectedScenarioId) return;
    
    setCreating(true);
    await onCreateRun(selectedScenarioId);
    setCreating(false);
  };
  
  if (loading) {
    return (
      <div className="w-full p-4 text-center text-gray-500">
        Loading scenarios...
      </div>
    );
  }
  
  if (scenarios.length === 0) {
    return (
      <div className="w-full p-4 text-center text-gray-500">
        <p>No scenarios available</p>
        <p className="text-sm">Create scenarios in the Scenario Builder first</p>
      </div>
    );
  }
  
  return (
    <div className="w-full space-y-3">
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-1">
          Select Scenario
        </label>
        <select
          value={selectedScenarioId}
          onChange={(e) => setSelectedScenarioId(e.target.value)}
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {scenarios.map(scenario => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.name}
            </option>
          ))}
        </select>
      </div>
      <button
        onClick={handleCreate}
        disabled={creating || !selectedScenarioId}
        className="w-full px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:opacity-50"
      >
        {creating ? 'Creating Run...' : '+ Create New Run'}
      </button>
    </div>
  );
}

// Main conversation monitor component
function ConversationMonitor() {
  const { connected, activeRuns, conversationStates, subscribeToRun, triggerAgent, createRun } = useMonitorWebSocket();
  const [selectedRunId, setSelectedRunId] = useState<string>('');
  const [selectedTrace, setSelectedTrace] = useState<ExecutionTrace | null>(null);

  // Auto-select first run if available
  useEffect(() => {
    if (activeRuns.length > 0 && !selectedRunId) {
      const firstRun = activeRuns[0];
      setSelectedRunId(firstRun!.runId);
      subscribeToRun(firstRun!.runId);
    }
  }, [activeRuns, selectedRunId, subscribeToRun]);

  const handleRunSelect = (runId: string) => {
    if (runId !== selectedRunId) {
      setSelectedRunId(runId);
      setSelectedTrace(null);
      subscribeToRun(runId);
    }
  };

  const selectedRunState = selectedRunId ? conversationStates.get(selectedRunId) : undefined;
  const selectedRunAgents = activeRuns.find(r => r.runId === selectedRunId)?.agents || [];

  return (
    <div className="h-screen flex bg-gray-100">
      {/* Run List Sidebar */}
      <div className="w-80 bg-white border-r flex flex-col">
        <div className="p-4 border-b">
          <h2 className="font-semibold text-lg">Active Runs</h2>
          <div className="flex items-center gap-2 mt-2">
            <div className={`w-2 h-2 rounded-full ${connected ? 'bg-green-500' : 'bg-red-500'}`} />
            <span className="text-sm text-gray-600">
              {connected ? 'Connected' : 'Disconnected'}
            </span>
          </div>
        </div>
        
        <div className="flex-1 overflow-y-auto">
          {activeRuns.length === 0 ? (
            <div className="p-4 text-center text-gray-500">
              <p>No active runs</p>
              <p className="text-sm mb-4">Create a run to start monitoring</p>
              <CreateRunButton onCreateRun={createRun} />
            </div>
          ) : (
            activeRuns.map(run => (
              <div
                key={run.runId}
                className={`p-4 border-b cursor-pointer hover:bg-gray-50 ${
                  selectedRunId === run.runId ? 'bg-blue-50 border-l-4 border-l-blue-500' : ''
                }`}
                onClick={() => handleRunSelect(run.runId)}
              >
                <div className="font-medium text-sm mb-1">
                  Run: {run.runId.split('_')[1]}...
                </div>
                <div className="flex gap-1 mb-2">
                  {run.agents.map(agent => (
                    <RoleBadge key={agent} role={agent} />
                  ))}
                </div>
                {selectedRunId === run.runId && (
                  <AgentTrigger
                    runId={run.runId}
                    agents={run.agents}
                    onTrigger={triggerAgent}
                  />
                )}
              </div>
            ))
          )}
          
          {activeRuns.length > 0 && (
            <div className="p-4 border-t">
              <CreateRunButton onCreateRun={createRun} />
            </div>
          )}
        </div>
      </div>

      {/* Main Conversation View */}
      <div className="flex-1 flex">
        <div className="flex-1">
          {selectedRunId && selectedRunState ? (
            <LiveConversation
              runId={selectedRunId}
              state={selectedRunState}
              onSelectTrace={setSelectedTrace}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-gray-500">
              <div className="text-center">
                <p className="text-lg mb-2">Select a run to monitor</p>
                <p className="text-sm">Real-time conversation updates will appear here</p>
              </div>
            </div>
          )}
        </div>

        {/* Trace Inspector */}
        <div className="w-96 bg-white border-l">
          <TraceInspector trace={selectedTrace} runId={selectedRunId} />
        </div>
      </div>
    </div>
  );
}

// Initialize the React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<ConversationMonitor />);
} else {
  console.error('Root container not found');
}