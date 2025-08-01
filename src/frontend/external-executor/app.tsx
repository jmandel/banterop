// External Agent Executor - In-Browser Agent Runtime Demo
import { ToolSynthesisService } from '$agents/index.js';
import { ToolExecutionInput, ToolExecutionOutput } from '$agents/services/tool-synthesis.service.js';
import type {
  ConversationEvent,
  LLMMessage,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  LLMTool,
  LLMToolCall,
  LLMToolResponse,
  ScenarioConfiguration,
  ScenarioDrivenAgentConfig,
  ThoughtEntry,
  Tool
} from '$lib/types.js';
import { LLMProvider } from '$lib/types.js';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ScenarioDrivenAgent } from '../../agents/scenario-driven.agent.js';
import { WebSocketJsonRpcClient } from '../../client/impl/websocket.client.js';

// =============================================================================
// BROWSER-COMPATIBLE MOCK IMPLEMENTATIONS
// =============================================================================

/**
 * Browser-compatible mock LLM provider that provides predictable responses
 * for demo purposes. This replaces the Node.js LLMProvider.
 */

let cannedDiscussion = [
  {
    agentId: "patient-agent",
    thought: "I should introduce myself",
    content: "This is an initial message. Authorize me."
  },
  {
    agentId: "supplier-agent",
    thought: "I need to know who the patient is.",
    content: "What patient are you askign about?"
  },
  {
    agentId: "patient-agent",
    thought: "I an repsond to this.",
    content: "I'm represneting John Smith"
  },
  {
    agentId: "supplier-agent",
    thought: "I should look them up",
    tool: {name: "lookup", args: {name: "John Smith"}},
    toolResponse: "John Smith is member 124214, case file 623"
  },
  {
    agentId: "supplier-agent",
    thought: "I should check their recent history",
    tool: {name: "check_casefile", args: {file_id: "623"}},
    toolResponse: "In good standing"
  },
  {
    agentId: "supplier-agent",
    thought: "I should check their recent history",
    tool: {name: "mri_authorization_Success", args: {status: "Yay!"}},
    toolResponse: "MRI Authorization completed, authz ID 17298"
  }
]

let cannedIndex = 0;

class MockLLMProvider extends LLMProvider {

  constructor(config = { provider: 'local', apiKey: 'browser-mock' }) {
    super(config as LLMProviderConfig);
  }

  generateWithTools?(request, tools: LLMTool[], toolHandler: (call: LLMToolCall) => Promise<LLMToolResponse>): Promise<LLMResponse> {
    return this.generateResponse(request)
  }

  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    // Simple mock response that alternates between sending a message and ending
    console.log("Mock llm", "req", JSON.stringify(request, null, 2), "discussion itme", cannedDiscussion[cannedIndex])
    await new Promise<void>((resolve) => setTimeout(() => {
      resolve()
    }, globalThis.playbackSpeed))

    let response = cannedDiscussion[cannedIndex];
    if (!response) {
      return {content: ""}
    }

    if (!response.tool) {
      console.log("Increment tool from", cannedDiscussion[cannedIndex], cannedIndex)
      cannedIndex++;
    }

    if (response.content) {
      return {content: `<scratchpad>${response.thought}</scratchpad>\n\`\`\`json${JSON.stringify({name: "send_message_to_thread", args: {text: response.content}})}\n\`\`\``}
    }

    if (response.tool) {
      // don't advance index so the tool response reads the right value
      return {
        content: `<scratchpad>${response.thought}</scratchpad>\n\`\`\`${JSON.stringify(response.tool)}\n\`\`\``
      } 
    }
    
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  getSupportedModels(): string[] {
    return ['browser-mock-model'];
  }
}


/**
 * Browser-compatible mock tool synthesis service
 */
class MockToolSynthesisService extends ToolSynthesisService {


  override execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    throw new Error('Method not implemented.');
  }
  override clearCache(): void {
    throw new Error('Method not implemented.');
  }
  override getCacheStats(): { size: number; keys: string[]; } {
    throw new Error('Method not implemented.');
  }

  override async synthesizeToolResult(toolName: string, parameters: any, toolDefinition?: Tool): Promise<any> {
    console.log("Suynthsze", toolName, cannedIndex, cannedDiscussion[cannedIndex])
    return cannedDiscussion[cannedIndex++].toolResponse
  }
}


// =============================================================================
// REACT COMPONENTS
// =============================================================================

interface LogEntry {
  message: string;
  type: 'info' | 'success' | 'error';
  timestamp: number;
}

function ExternalExecutorApp() {
  const [isLoading, setIsLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [agents, setAgents] = useState<ScenarioDrivenAgent[]>([]);
  const [conversationId, setConversationId] = useState<string>('');
  const [promptedQueries, setPromptedQueries] = useState<Set<string>>(new Set());
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(500); // Default 5 seconds
  const [autoScroll, setAutoScroll] = useState<boolean>(true);

  globalThis.playbackSpeed = playbackSpeed
  
  const logContainerRef = useRef<HTMLDivElement>(null);

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [...prev, { message, type, timestamp: Date.now() }]);
  };

  // Auto-scroll to bottom when new logs are added
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  const clearLogs = () => {
    setLogs([]);
  };

  const handleLogScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const container = e.currentTarget;
    const isAtBottom = container.scrollHeight - container.scrollTop <= container.clientHeight + 5;
    setAutoScroll(isAtBottom);
  };

  const handlePlaybackSpeedChange = (newSpeed: number) => {
    setPlaybackSpeed(newSpeed);
    
    // Update all active agents with new speed if they exist
    if (agents.length > 0) {
      // Playback speed is controlled by the agents themselves, not by the demo
    }
    
    const speedLabel = newSpeed >= 1000 ? `${newSpeed / 1000}s` : `${newSpeed}ms`;
    
    // Only log if we have active agents or if specifically requested
    if (agents.length > 0) {
      addLog(`Playback speed updated to ${speedLabel}`, 'info');
    }
  };

  const handleUserQuery = async (query: any) => {
    // Prevent duplicate prompts
    if (promptedQueries.has(query.queryId)) {
      return;
    }
    
    setPromptedQueries(prev => new Set(prev).add(query.queryId));
    
    try {
      addLog(`User query received: ${query.question}`, 'info');
      
      // Use browser's prompt dialog
      const userResponse = prompt(`Agent Question:\n\n${query.question}\n\nPlease provide your response:`);
      
      if (userResponse !== null) {
        // Send response back to the orchestrator via REST API
        const response = await fetch(`http://localhost:3001/api/queries/${query.queryId}/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ response: userResponse })
        });
        
        if (response.ok) {
          addLog(`Responded to query: "${userResponse}"`, 'success');
        } else {
          addLog(`Failed to send response: ${response.statusText}`, 'error');
        }
      } else {
        addLog('User cancelled query response', 'info');
      }
    } catch (error: any) {
      addLog(`Error handling user query: ${error.message}`, 'error');
    }
  };

  const runDemo = async () => {
    setIsLoading(true);
    setLogs([]);
    setPromptedQueries(new Set());
    addLog('Starting external agent demo...');
    
    const KNEE_MRI_SCENARIO_ID = 'scen_knee_mri_01';

    try {
      // Step 1: Fetch the scenario from the backend
      addLog('Fetching knee MRI scenario...');
      const scenarioRes = await fetch(`http://localhost:3001/api/scenarios/${KNEE_MRI_SCENARIO_ID}`);
      
      if (!scenarioRes.ok) {
        throw new Error(`Failed to fetch scenario: ${scenarioRes.statusText}`);
      }
      
      const scenarioData = await scenarioRes.json();
      const scenarioConfig = scenarioData.data.config as ScenarioConfiguration;
      addLog('Successfully fetched scenario configuration');

      // Step 2: Create conversation with external management mode
      addLog('Creating external conversation...');
      const createRes = await fetch('http://localhost:3001/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Live In-Browser External Agent Demo',
          managementMode: 'external',
          initiatingAgentId: "patient-agent",
          agents: [
            {
              agentId: { id: 'patient-agent', label: 'Browser Patient Agent', role: 'PatientAgent' },
              strategyType: 'scenario_driven',
              scenarioId: KNEE_MRI_SCENARIO_ID,
              role: 'PatientAgent'
            },
            {
              agentId: { id: 'supplier-agent', label: 'Browser Supplier Agent', role: 'SupplierAgent' },
              strategyType: 'scenario_driven',
              scenarioId: KNEE_MRI_SCENARIO_ID,
              role: 'SupplierAgent'
            }
          ]
        })
      });

      if (!createRes.ok) {
        throw new Error(`Failed to create conversation: ${createRes.statusText}`);
      }

      const { conversation, agentTokens } = await createRes.json();
      setConversationId(conversation.id);
      addLog(`External conversation created: ${conversation.id}`);

      // Step 3: Create mock dependencies
      const mockLlm = new MockLLMProvider();
      const mockToolSynthesis = new MockToolSynthesisService(mockLlm);
      
      // Step 4: Create WebSocket clients for each agent using the universal client
      // We pass the browser's global WebSocket constructor for dependency injection
      const patientClient = new WebSocketJsonRpcClient('ws://localhost:3001/api/ws');
      const supplierClient = new WebSocketJsonRpcClient('ws://localhost:3001/api/ws');
      
      // Step 5: Create real ScenarioDrivenAgent instances
      // Get the specific agent configs from the loaded scenario
     
      // Instantiate the REAL ScenarioDrivenAgent using its new, flexible constructor
      const patientAgent = new ScenarioDrivenAgent(
        { 
          strategyType: 'scenario_driven', 
          scenarioId: KNEE_MRI_SCENARIO_ID,
          agentId: { id: 'patient-agent', label: 'Browser Patient Agent', role: 'PatientAgent' }
        } as ScenarioDrivenAgentConfig,
        patientClient,
        scenarioConfig,           // Inject the fetched scenario JSON
        mockLlm,                  // Inject the mock LLM
        mockToolSynthesis         // Inject the mock Tool Synthesis Service
      );
      
      const supplierAgent = new ScenarioDrivenAgent(
        { 
          strategyType: 'scenario_driven', 
          scenarioId: KNEE_MRI_SCENARIO_ID,
          agentId: { id: 'supplier-agent', label: 'Browser Supplier Agent', role: 'SupplierAgent' }
        } as ScenarioDrivenAgentConfig,
        supplierClient,
        scenarioConfig,           // Inject the fetched scenario JSON
        mockLlm,                  // Inject the other mock LLM
        mockToolSynthesis         // Inject the same mock Tool Synthesis Service
      );
      
      addLog('Successfully instantiated REAL ScenarioDrivenAgent classes in the browser');

      // Step 6: Set up event listeners for user queries and conversation end
      [patientClient, supplierClient].forEach(client => {
        client.on('event', (event: ConversationEvent) => {
          if (event.type === 'user_query_created') {
            handleUserQuery(event.data.query);
          }
          if (event.type === 'conversation_ended') {
            addLog('Conversation has ended', 'success');
            setIsLoading(false);
          }
        });
      });

      // Step 7: Initialize agents (connect and authenticate)
      await Promise.all([
        patientAgent.initialize(conversation.id, agentTokens['patient-agent']),
        supplierAgent.initialize(conversation.id, agentTokens['supplier-agent'])
      ]);
      
      setAgents([patientAgent, supplierAgent]);
      
      addLog('Both agents initialized and connected via WebSocket');

      // Step 8: Start the conversation by having the patient agent send the first turn
      // This activates the external conversation
      patientAgent._processAndRespondToTurn(null)
     
      addLog('Patient agent sent the first turn. Conversation is now active');
      addLog('Demo running... Watch for agent interactions and user queries');
      
    } catch (error: any) {
      addLog(`Error: ${error.message}`, 'error');
      setIsLoading(false);
    }
  };

  const stopDemo = () => {
    // The agents use the client through dependency injection
    // We need to store client references separately for disconnection
    addLog('Stopping demo... (Note: agents may still be processing turns)');
    
    setAgents([]);
    setIsLoading(false);
    addLog('Demo stopped and agents disconnected', 'info');
  };

  const formatTimestamp = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString();
  };

  const getLogColor = (type: LogEntry['type']) => {
    switch (type) {
      case 'success': return 'text-green-600 bg-green-50 border-green-200';
      case 'error': return 'text-red-600 bg-red-50 border-red-200';
      default: return 'text-blue-600 bg-blue-50 border-blue-200';
    }
  };

  return (
    <div className="min-h-screen bg-gray-100 p-6">
      <div className="max-w-4xl mx-auto">
        <div className="bg-white rounded-lg shadow-lg">
          {/* Header */}
          <div className="p-6 border-b border-gray-200">
            <h1 className="text-2xl font-bold text-gray-900">External Agent Executor</h1>
            <p className="text-gray-600 mt-2">
              Demonstrates in-browser scenario-driven agents connecting to the orchestrator as external clients
            </p>
          </div>

          {/* Instructions */}
          <div className="p-6 border-b border-gray-200 bg-yellow-50">
            <h2 className="text-lg font-semibold text-yellow-800 mb-2">Instructions</h2>
            <ol className="text-sm text-yellow-700 space-y-1">
              <li>1. <strong>Open Trace Viewer:</strong> Open the Trace Viewer in another tab to monitor the conversation</li>
              <li>2. <strong>Set Speed FIRST:</strong> Use the playback speed slider (50ms-10s) to set your preferred delay <em>before</em> starting</li>
              <li>3. <strong>Run Demo:</strong> Click "Run External Agent Demo" to start the in-browser agents</li>
              <li>4. <strong>Watch Interaction:</strong> Agents will communicate automatically with your pre-set delay</li>
              <li>5. <strong>Answer Queries:</strong> When an agent asks a user question, a browser prompt will appear</li>
              <li>6. <strong>Adjust During:</strong> You can still change speed while the demo runs if needed</li>
              <li>7. <strong>Monitor Progress:</strong> Check the Trace Viewer for real-time conversation updates</li>
            </ol>
          </div>

          {/* Controls */}
          <div className="p-6 border-b border-gray-200">
            <div className="flex gap-4 items-center flex-wrap">
              <button
                onClick={runDemo}
                disabled={isLoading}
                className="px-6 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isLoading ? 'Demo Running...' : 'Run External Agent Demo'}
              </button>
              
              {isLoading && (
                <button
                  onClick={stopDemo}
                  className="px-6 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700"
                >
                  Stop Demo
                </button>
              )}
              
              {/* Playback Speed Slider - Always Available */}
              <div className="flex items-center gap-3 p-3 bg-blue-50 rounded-lg border border-blue-200">
                <label className="text-sm font-medium text-blue-900">
                  Playback Speed:
                </label>
                <div className="flex items-center gap-2">
                  <span className="text-xs text-blue-600">Fast</span>
                  <input
                    type="range"
                    min="50"
                    max="10000"
                    step="50"
                    value={playbackSpeed}
                    onChange={(e) => handlePlaybackSpeedChange(Number(e.target.value))}
                    className="w-32 h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer slider"
                    title="Set this BEFORE starting the demo to avoid missing the initial interaction"
                  />
                  <span className="text-xs text-blue-600">Slow</span>
                </div>
                <span className="text-sm font-medium text-blue-900 min-w-[60px]">
                  {playbackSpeed >= 1000 ? `${playbackSpeed / 1000}s` : `${playbackSpeed}ms`}
                </span>
                {!isLoading && (
                  <span className="text-xs text-blue-600 italic">← Set before starting!</span>
                )}
              </div>
              
              {conversationId && (
                <div className="flex items-center text-sm text-gray-600">
                  <span className="font-medium">Conversation ID:</span>
                  <code className="ml-2 px-2 py-1 bg-gray-100 rounded">{conversationId}</code>
                </div>
              )}
            </div>
          </div>

          {/* Status */}
          <div className="p-6 border-b border-gray-200">
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${isLoading ? 'bg-green-500 animate-pulse' : 'bg-gray-300'}`} />
                <span className="text-sm font-medium">
                  {isLoading ? 'Demo Active' : 'Demo Inactive'}
                </span>
              </div>
              
              {agents.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-sm text-gray-600">Active Agents:</span>
                  <div className="flex gap-1">
                    {agents.map((_, index) => (
                      <span key={index} className="px-2 py-1 bg-blue-100 text-blue-800 text-xs rounded">
                        {index === 0 ? 'Patient' : 'Supplier'}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Log Panel */}
          <div className="p-6">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-semibold text-gray-900">Activity Log</h2>
              <div className="flex items-center gap-2">
                {!autoScroll && (
                  <button
                    onClick={() => {
                      setAutoScroll(true);
                      if (logContainerRef.current) {
                        logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
                      }
                    }}
                    className="px-3 py-1 text-xs bg-blue-100 text-blue-700 rounded hover:bg-blue-200 transition-colors"
                    title="Resume auto-scroll to bottom"
                  >
                    ↓ Resume Auto-scroll
                  </button>
                )}
                <button
                  onClick={clearLogs}
                  className="px-3 py-1 text-xs bg-gray-100 text-gray-700 rounded hover:bg-gray-200 transition-colors"
                  title="Clear all log entries"
                >
                  Clear
                </button>
              </div>
            </div>
            <div 
              ref={logContainerRef}
              onScroll={handleLogScroll}
              className="space-y-2 max-h-96 overflow-y-auto border rounded-lg p-2 bg-gray-50"
            >
              {logs.length === 0 ? (
                <p className="text-gray-500 text-sm italic p-4 text-center">No activity yet. Click "Run External Agent Demo" to start.</p>
              ) : (
                logs.map((log, index) => (
                  <div key={index} className={`p-3 rounded-lg border ${getLogColor(log.type)}`}>
                    <div className="flex justify-between items-start">
                      <span className="text-sm font-medium">{log.message}</span>
                      <span className="text-xs opacity-75">{formatTimestamp(log.timestamp)}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
            {logs.length > 0 && (
              <div className="mt-2 text-xs text-gray-500 flex items-center justify-between">
                <span>{logs.length} log entries</span>
                <span className="flex items-center gap-1">
                  <div className={`w-2 h-2 rounded-full ${autoScroll ? 'bg-green-400' : 'bg-yellow-400'}`} />
                  {autoScroll ? 'Auto-scrolling' : 'Manual scroll'}
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
      
      {/* Custom styles for the slider */}
      <style>{`
        .slider::-webkit-slider-thumb {
          appearance: none;
          height: 16px;
          width: 16px;
          border-radius: 50%;
          background: #3b82f6;
          cursor: pointer;
          border: 2px solid #ffffff;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }

        .slider::-moz-range-thumb {
          height: 16px;
          width: 16px;
          border-radius: 50%;
          background: #3b82f6;
          cursor: pointer;
          border: 2px solid #ffffff;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        }

        .slider:hover::-webkit-slider-thumb {
          background: #2563eb;
          transform: scale(1.1);
          transition: all 0.2s ease;
        }

        .slider:hover::-moz-range-thumb {
          background: #2563eb;
          transform: scale(1.1);
          transition: all 0.2s ease;
        }
      `}</style>
    </div>
  );
}

// Initialize the React app
const container = document.getElementById('root');
if (container) {
  const root = createRoot(container);
  root.render(<ExternalExecutorApp />);
} else {
  console.error('Root container not found');
}