// External Agent Executor - In-Browser Agent Runtime Demo
import './tailwind-bundle.css';
import { ToolSynthesisService } from '$agents/index.js';
import { ToolExecutionInput, ToolExecutionOutput } from '$agents/services/tool-synthesis.service.js';
import type {
  ConversationEvent,
  LLMProviderConfig,
  LLMRequest,
  LLMResponse,
  ScenarioConfiguration,
  ScenarioDrivenAgentConfig,
  Tool
} from '$lib/types.js';
import { LLMProvider } from '$lib/types.js';
import { getInitiationDetails } from '$lib/utils/conversation-helpers.js';
import React, { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { ScenarioDrivenAgent } from '../../agents/scenario-driven.agent.js';
import { WebSocketJsonRpcClient } from '../../client/impl/websocket.client.js';

// =============================================================================
// BROWSER-COMPATIBLE MOCK IMPLEMENTATIONS
// =============================================================================

/**
 * Browser-compatible LLM provider that calls the backend REST API
 * This keeps the API key secure on the server while allowing browser agents to use real LLM
 */
class RemoteLLMProvider extends LLMProvider {
  private baseUrl: string;
  private model?: string;

  constructor(baseUrl: string = 'http://localhost:3001', model?: string) {
    super({ provider: 'remote', apiKey: 'not-needed', model } as LLMProviderConfig);
    this.baseUrl = baseUrl;
    this.model = model;
  }

  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    try {
      const response = await fetch(`${this.baseUrl}/api/llm/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...request,
          model: this.model || request.model
        })
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => response.statusText);
        throw new Error(`LLM request failed (${response.status}): ${errorText}`);
      }

      const result = await response.json();
      if (!result.success) {
        throw new Error(result.error || 'LLM generation failed');
      }

      return result.data;
    } catch (error) {
      console.error('Remote LLM error:', error);
      // Add more context to network errors
      if (error instanceof TypeError && error.message.includes('fetch')) {
        throw new Error(`Network error: Unable to connect to LLM service at ${this.baseUrl}. Is the backend running?`);
      }
      throw error;
    }
  }

  getSupportedModels(): string[] {
    return ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'];
  }
}

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
    agentId: "insurance-auth-specialist",
    thought: "I need to know who the patient is.",
    content: "What patient are you askign about?"
  },
  {
    agentId: "patient-agent",
    thought: "I an repsond to this.",
    content: "I'm represneting John Smith"
  },
  {
    agentId: "insurance-auth-specialist",
    thought: "I should look them up",
    tool: {name: "lookup", args: {name: "John Smith"}},
    toolResponse: "John Smith is member 124214, case file 623"
  },
  {
    agentId: "insurance-auth-specialist",
    thought: "I should check their recent history",
    tool: {name: "check_casefile", args: {file_id: "623"}},
    toolResponse: "In good standing"
  },
  {
    agentId: "insurance-auth-specialist",
    thought: "I should check their recent history",
    tool: {name: "mri_authorization_Success", args: {status: "Yay!"}},
    toolResponse: "MRI Authorization completed, authz ID 17298"
  }
]

// Canned discussion with user query support
let cannedDiscussionWithQuery = [
  {
    agentId: "patient-agent",
    thought: "I should introduce myself and request MRI authorization",
    content: "Hello, I need authorization for a knee MRI for my patient John Smith."
  },
  {
    agentId: "insurance-auth-specialist",
    thought: "I need more information about the request",
    content: "I can help with that. What is the reason for the MRI request?"
  },
  {
    agentId: "patient-agent",
    thought: "I should provide the clinical reason",
    content: "The patient has been experiencing chronic knee pain for several weeks following a sports injury."
  },
  {
    agentId: "insurance-auth-specialist",
    thought: "I need to look up the patient in our system",
    tool: {name: "lookup", args: {name: "John Smith"}},
    toolResponse: "John Smith is member 124214, case file 623"
  },
  {
    agentId: "insurance-auth-specialist",
    thought: "I need the specific date of injury for the authorization",
    content: "I found the patient's record. However, I need the specific date of the initial injury to process this authorization."
  },
  {
    agentId: "patient-agent",
    thought: "I don't have the exact injury date in my records. I need to ask my principal for this information.",
    tool: {name: "ask_question_to_principal", args: {text: "What was the date of John Smith's initial knee injury?"}},
    toolResponse: "The initial injury occurred on June 1st, 2024."
  },
  {
    agentId: "patient-agent",
    thought: "Now I have the injury date from my principal, I can provide it to the insurance specialist",
    content: "Thank you for waiting. The initial injury occurred on June 1st, 2024."
  },
  {
    agentId: "insurance-auth-specialist",
    thought: "Now I have all the information I need. Let me check their case file",
    tool: {name: "check_casefile", args: {file_id: "623"}},
    toolResponse: "In good standing, eligible for MRI authorization"
  },
  {
    agentId: "insurance-auth-specialist",
    thought: "Everything looks good, I'll approve the MRI",
    tool: {name: "mri_authorization_Success", args: {status: "Approved", injury_date: "2024-06-01"}},
    toolResponse: "MRI Authorization completed, authz ID 17298"
  }
]

let cannedIndex = 0;

class MockLLMProvider extends LLMProvider {

  constructor(config = { provider: 'local', apiKey: 'browser-mock' }) {
    super(config as LLMProviderConfig);
  }

  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    // Simple mock response that alternates between sending a message and ending
    console.log("Mock llm", "req", request.messages[0].content, "discussion item", cannedDiscussionWithQuery[cannedIndex])
    await new Promise<void>((resolve) => setTimeout(() => {
      resolve()
    }, globalThis.playbackSpeed))

    let response = cannedDiscussionWithQuery[cannedIndex];
    if (!response) {
      return {content: ""}
    }

    // Advance index for content messages and ask_question_to_principal
    // Don't advance for other tools (we need to read the tool response next)
    if (!response.tool || response.tool.name === 'ask_question_to_principal') {
      console.log("Increment index from", cannedDiscussionWithQuery[cannedIndex], cannedIndex)
      cannedIndex++;
    }

    if (response.content) {
      return {content: `<scratchpad>${response.thought}</scratchpad>\n\`\`\`json\n${JSON.stringify({name: "send_message_to_agent_conversation", args: {text: response.content}})}\n\`\`\``}
    }

    if (response.tool) {
      // don't advance index so the tool response reads the right value (except for ask_question_to_principal which we already advanced)
      return {
        content: `<scratchpad>${response.thought}</scratchpad>\n\`\`\`json\n${JSON.stringify(response.tool)}\n\`\`\``
      } 
    }
    
  }

  getSupportedModels(): string[] {
    return ['browser-mock-model'];
  }
}


/**
 * Browser-compatible mock tool synthesis service
 */
class MockToolSynthesisService extends ToolSynthesisService {


  override async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
  // async synthesizeToolResult(toolName: string, parameters: any, toolDefinition?: Tool): Promise<any> {
    const {toolName, args } = input;
    console.log("Synthesize", toolName, cannedIndex, cannedDiscussionWithQuery[cannedIndex])
    // Don't synthesize ask_question_to_principal - it should be handled by the agent itself
    if (toolName === 'ask_question_to_principal') {
      throw new Error('ask_question_to_principal should be handled by the agent, not synthesized');
    }
    return { output: cannedDiscussionWithQuery[cannedIndex++].toolResponse };
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

interface OutstandingQuery {
  queryId: string;
  agentId: string;
  question: string;
  suggestedResponse: string;
  currentResponse: string; // User's editable text
}

function ExternalExecutorApp() {
  const [isLoading, setIsLoading] = useState(false);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [agents, setAgents] = useState<ScenarioDrivenAgent[]>([]);
  const [conversationId, setConversationId] = useState<string>('');
  const [outstandingQueries, setOutstandingQueries] = useState<Map<string, OutstandingQuery>>(new Map());
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(500); // Default 5 seconds
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  const [llmProvider, setLlmProvider] = useState<'mock' | 'gemini' | 'openrouter'>('mock');
  const [availableModels, setAvailableModels] = useState<{ gemini: string[], openrouter: string[] }>({ gemini: [], openrouter: [] });
  const [selectedModel, setSelectedModel] = useState<string>('openai/gpt-oss-20b');
  const [backendUrl, setBackendUrl] = useState<string>(() => {
    // Load from localStorage or use default
    const stored = localStorage.getItem('external-executor-backend-url');
    // Validate that it's a proper URL
    if (stored && stored.startsWith('http')) {
      return stored;
    }
    return 'http://localhost:3001';
  });
  const [checkingConnection, setCheckingConnection] = useState<boolean>(true);
  const [isConnected, setIsConnected] = useState<boolean>(false);
  const [llmAvailable, setLlmAvailable] = useState<boolean>(false);
  const [initInstructions, setInitInstructions] = useState<string>('Please be concise in your first message.');

  globalThis.playbackSpeed = playbackSpeed
  
  const logContainerRef = useRef<HTMLDivElement>(null);

  const addLog = (message: string, type: LogEntry['type'] = 'info') => {
    setLogs(prev => [...prev, { message, type, timestamp: Date.now() }]);
  };

  const checkLLMAvailability = async (url: string) => {
    setCheckingConnection(true);
    try {
      // Simple fetch without extra headers
      const response = await fetch(`${url}/api/llm/config`);
      
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      
      const result = await response.json();
      
      if (result.success) {
        setIsConnected(true);
        
        // Check if any provider is configured
        let anyProviderConfigured = false;
        const modelsByProvider = { gemini: [] as string[], openrouter: [] as string[] };
        
        if (result.data?.providers && Array.isArray(result.data.providers)) {
          result.data.providers.forEach((provider: any) => {
            // If a provider has models, it's configured
            if (provider.models && provider.models.length > 0) {
              anyProviderConfigured = true;
              if (provider.name === 'google') {
                modelsByProvider.gemini = provider.models;
              } else if (provider.name === 'openrouter') {
                modelsByProvider.openrouter = provider.models;
              }
            }
          });
        }
        
        setLlmAvailable(anyProviderConfigured);
        setAvailableModels(modelsByProvider);
        
        // Set default model based on selected provider
        if (llmProvider === 'gemini' && modelsByProvider.gemini.length > 0) {
          setSelectedModel(modelsByProvider.gemini[0]);
        } else if (llmProvider === 'openrouter' && modelsByProvider.openrouter.length > 0) {
          setSelectedModel(modelsByProvider.openrouter[0]);
        }
        
        if (anyProviderConfigured) {
          addLog('Backend connected with LLM provider(s) configured', 'success');
        } else {
          addLog('Backend connected but no LLM providers configured. Using mock responses.', 'info');
        }
      } else {
        setIsConnected(false);
        setLlmAvailable(false);
        addLog('Backend connection failed', 'error');
      }
    } catch (error) {
      console.error('Error checking LLM config:', error);
      setIsConnected(false); // Cannot reach backend at all
      setLlmAvailable(false);
      setAvailableModels({ gemini: [], openrouter: [] });
      addLog(`Cannot connect to backend at ${url}: ${error instanceof Error ? error.message : 'Unknown error'}`, 'error');
    } finally {
      setCheckingConnection(false);
    }
  };

  const handleBackendUrlChange = (newUrl: string) => {
    setBackendUrl(newUrl);
    // Only save valid URLs to localStorage
    if (newUrl && newUrl.startsWith('http')) {
      localStorage.setItem('external-executor-backend-url', newUrl);
      // Re-check LLM availability with new URL
      checkLLMAvailability(newUrl);
    }
  };

  // Auto-scroll to bottom when new logs are added
  useEffect(() => {
    if (autoScroll && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logs, autoScroll]);

  // Check if LLM is available and fetch models on mount and when backend URL changes
  useEffect(() => {
    checkLLMAvailability(backendUrl);
  }, [backendUrl]);

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


  const runDemo = async () => {
    setIsLoading(true);
    setLogs([]);
    setOutstandingQueries(new Map());
    addLog('Starting external agent demo...');
    
    const KNEE_MRI_SCENARIO_ID = 'scen_knee_mri_01';

    try {
      // Step 1: Fetch the scenario from the backend
      addLog('Fetching knee MRI scenario...');
      const scenarioRes = await fetch(`${backendUrl}/api/scenarios/${KNEE_MRI_SCENARIO_ID}`);
      
      if (!scenarioRes.ok) {
        throw new Error(`Failed to fetch scenario: ${scenarioRes.statusText}`);
      }
      
      const scenarioData = await scenarioRes.json();
      const scenarioConfig = scenarioData.data.config as ScenarioConfiguration;
      addLog('Successfully fetched scenario configuration');

      // Step 2: Create conversation with external management mode
      addLog('Creating external conversation...');
      const createRes = await fetch(`${backendUrl}/api/conversations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          metadata: {
            conversationTitle: 'Live In-Browser External Agent Demo',
            scenarioId: KNEE_MRI_SCENARIO_ID
          },
          agents: [
            {
              id: 'patient-agent',
              strategyType: 'external_websocket_client',
              shouldInitiateConversation: true,
              additionalInstructions: initInstructions || undefined
            },
            {
              id: 'insurance-auth-specialist',
              strategyType: 'external_websocket_client'
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

      // Step 3: Create dependencies based on selected LLM provider
      const llmProviderInstance = llmProvider === 'mock' 
        ? new MockLLMProvider() 
        : new RemoteLLMProvider(backendUrl, selectedModel);
      const toolSynthesis = llmProvider === 'mock' 
        ? new MockToolSynthesisService(llmProviderInstance) 
        : new ToolSynthesisService(llmProviderInstance);
      
      if (llmProvider !== 'mock') {
        addLog(`Using real LLM via backend API (Provider: ${llmProvider}, Model: ${selectedModel}) for both agent responses and tool synthesis`);
        // Reset canned index when using real LLM
        cannedIndex = 0;
      } else {
        addLog('Using mock LLM with pre-scripted responses for both agent responses and tool synthesis');
      }
      
      // Step 4: Create WebSocket clients for each agent using the universal client
      // Convert HTTP URL to WebSocket URL
      const wsUrl = backendUrl.replace(/^http/, 'ws');
      const patientClient = new WebSocketJsonRpcClient(`${wsUrl}/api/ws`);
      const supplierClient = new WebSocketJsonRpcClient(`${wsUrl}/api/ws`);
      
      // Step 5: Create real ScenarioDrivenAgent instances
      // Get the specific agent configs from the loaded scenario
     
      // Instantiate the REAL ScenarioDrivenAgent using its new, flexible constructor
      const patientAgent = new ScenarioDrivenAgent(
        { 
          strategyType: 'scenario_driven', 
          scenarioId: KNEE_MRI_SCENARIO_ID,
          id: 'patient-agent'
        } as ScenarioDrivenAgentConfig,
        patientClient,
        scenarioConfig,           // Inject the fetched scenario JSON
        llmProviderInstance,      // Inject the actual LLM provider instance, not the string!
        toolSynthesis             // Inject the Tool Synthesis Service
      );
      
      const supplierAgent = new ScenarioDrivenAgent(
        { 
          strategyType: 'scenario_driven', 
          scenarioId: KNEE_MRI_SCENARIO_ID,
          id: 'insurance-auth-specialist'
        } as ScenarioDrivenAgentConfig,
        supplierClient,
        scenarioConfig,           // Inject the fetched scenario JSON
        llmProviderInstance,      // Inject the actual LLM provider instance, not the string!
        toolSynthesis             // Inject the Tool Synthesis Service
      );
      
      addLog('Successfully instantiated REAL ScenarioDrivenAgent classes in the browser');

      // Step 6: Set up event listeners for user queries and conversation end
      [patientClient, supplierClient].forEach(client => {
        client.on('event', (event: ConversationEvent) => {
          if (event.type === 'user_query_created') {
            const query = (event as any).data.query;
            addLog(`User query received: ${query.question}`, 'info');
            
            // Find the suggested response from the canned discussion
            // Since we advanced the index, look at cannedIndex - 1
            const previousStep = cannedDiscussionWithQuery[cannedIndex - 1];
            const suggestedResponse = (previousStep?.tool?.name === "ask_question_to_principal" && 
                                      previousStep?.tool?.args?.text === query.question) 
                                      ? previousStep.toolResponse 
                                      : '';
            
            setOutstandingQueries(prev => {
              const newQueries = new Map(prev);
              newQueries.set(query.queryId, {
                queryId: query.queryId,
                agentId: query.agentId,
                question: query.question,
                suggestedResponse: suggestedResponse,
                currentResponse: suggestedResponse, // Pre-fill the input
              });
              return newQueries;
            });
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
        supplierAgent.initialize(conversation.id, agentTokens['insurance-auth-specialist'])
      ]);
      
      const myLocalAgents = [patientAgent, supplierAgent];
      setAgents(myLocalAgents);
      
      addLog('Both agents initialized and connected.');

      // --- NEW, CORRECT INITIATION LOGIC ---
      
      // 2. Get initiation details from the conversation object returned by the server.
      const { initiatingAgentId, instructions } = getInitiationDetails(conversation);
      addLog(`Nominated initiating agent: ${initiatingAgentId}`);

      if (!initiatingAgentId) {
        throw new Error('No initiating agent was specified for this conversation.');
      }
      
      // 3. Find the local agent instance that corresponds to the ID.
      const agentToStart = myLocalAgents.find(a => a.agentId === initiatingAgentId);

      if (agentToStart) {
        // 4. Command the nominated agent to start the conversation.
        addLog(`Commanding ${agentToStart.agentId} to initiate the conversation...`);
        // This single call now correctly kicks off the entire flow.
        await agentToStart.initializeConversation(instructions);
        addLog('First turn sent. Conversation is now active.');
      } else {
        addLog(`Error: Could not find local agent instance for ID ${initiatingAgentId}`, 'error');
      }
      
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

          {/* Backend Configuration */}
          <div className="p-6 border-b border-gray-200 bg-gray-50">
            <h2 className="text-lg font-semibold text-gray-800 mb-4">Backend Configuration</h2>
            <div className="flex items-center gap-4">
              <label htmlFor="backend-url" className="text-sm font-medium text-gray-700">
                Backend URL:
              </label>
              <input
                id="backend-url"
                type="text"
                value={backendUrl}
                onChange={(e) => handleBackendUrlChange(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="http://localhost:3001"
              />
              <div className="flex items-center gap-2">
                {checkingConnection ? (
                  <>
                    <div className="w-3 h-3 rounded-full bg-yellow-500 animate-pulse" />
                    <span className="text-sm text-gray-600">Checking...</span>
                  </>
                ) : (
                  <>
                    <div className={`w-3 h-3 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
                    <span className="text-sm text-gray-600">
                      {isConnected ? 'Connected' : 'Not Connected'}
                    </span>
                  </>
                )}
              </div>
            </div>
            {!isLoading && (
              <p className="mt-2 text-xs text-gray-500">
                URL for the backend API server. Changes are saved to localStorage.
              </p>
            )}
          </div>

          {/* Instructions */}
          <div className="p-6 border-b border-gray-200 bg-yellow-50">
            <h2 className="text-lg font-semibold text-yellow-800 mb-2">Instructions</h2>
            <ol className="text-sm text-yellow-700 space-y-1">
              <li>1. <strong>Configure Backend:</strong> Set the backend URL above if not using default localhost:3001</li>
              <li>2. <strong>Open Trace Viewer:</strong> Open the Trace Viewer in another tab to monitor the conversation</li>
              <li>3. <strong>Set Speed FIRST:</strong> Use the playback speed slider (50ms-10s) to set your preferred delay <em>before</em> starting</li>
              <li>4. <strong>Run Demo:</strong> Click "Run External Agent Demo" to start the in-browser agents</li>
              <li>5. <strong>Watch Interaction:</strong> Agents will communicate automatically with your pre-set delay</li>
              <li>6. <strong>Answer Queries:</strong> When an agent asks a user question, a browser prompt will appear</li>
              <li>7. <strong>Adjust During:</strong> You can still change speed while the demo runs if needed</li>
              <li>8. <strong>Monitor Progress:</strong> Check the Trace Viewer for real-time conversation updates</li>
            </ol>
          </div>

          {/* Controls */}
          <div className="p-6 border-b border-gray-200">
            <div className="space-y-4">
              {/* Initialization Instructions */}
              <div>
                <label htmlFor="init-instructions" className="block text-sm font-medium text-gray-700 mb-2">
                  Initialization Instructions (optional):
                </label>
                <input
                  id="init-instructions"
                  type="text"
                  value={initInstructions}
                  onChange={(e) => setInitInstructions(e.target.value)}
                  disabled={isLoading}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-100"
                  placeholder="e.g., 'Please be concise in your first message.'"
                />
                <p className="mt-1 text-xs text-gray-500">
                  These instructions will be passed to the initiating agent to modify their opening message.
                </p>
              </div>

              {/* Main Controls */}
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
              
              {/* LLM Provider Toggle */}
              <div className="flex items-center gap-3 p-3 bg-purple-50 rounded-lg border border-purple-200">
                <label className="text-sm font-medium text-purple-900">
                  LLM Provider:
                </label>
                <select
                  value={llmProvider}
                  onChange={(e) => {
                    const newProvider = e.target.value as 'mock' | 'gemini' | 'openrouter';
                    setLlmProvider(newProvider);
                    // Update selected model when switching providers
                    if (newProvider === 'gemini' && availableModels.gemini.length > 0) {
                      setSelectedModel(availableModels.gemini[0]);
                    } else if (newProvider === 'openrouter' && availableModels.openrouter.length > 0) {
                      setSelectedModel(availableModels.openrouter[0]);
                    }
                  }}
                  disabled={isLoading}
                  className="px-3 py-1 border border-purple-300 rounded text-sm"
                >
                  <option value="mock">Mock (Scripted)</option>
                  <option value="gemini" disabled={!llmAvailable || availableModels.gemini.length === 0}>
                    Gemini {(!llmAvailable || availableModels.gemini.length === 0) && '(Not Available)'}
                  </option>
                  <option value="openrouter" disabled={!llmAvailable || availableModels.openrouter.length === 0}>
                    OpenRouter {(!llmAvailable || availableModels.openrouter.length === 0) && '(Not Available)'}
                  </option>
                </select>
                
                {/* Model Selection Dropdown - Only shown when using real LLM */}
                {llmProvider !== 'mock' && llmAvailable && (
                  <>
                    <label className="text-sm font-medium text-purple-900 ml-4">
                      Model:
                    </label>
                    <select
                      value={selectedModel}
                      onChange={(e) => setSelectedModel(e.target.value)}
                      disabled={isLoading}
                      className="px-3 py-1 border border-purple-300 rounded text-sm"
                    >
                      {(llmProvider === 'gemini' ? availableModels.gemini : availableModels.openrouter).map(model => (
                        <option key={model} value={model}>
                          {model}
                        </option>
                      ))}
                    </select>
                  </>
                )}
                
                {llmProvider !== 'mock' && llmAvailable && (
                  <span className="text-xs text-purple-600 ml-2">
                    Using backend API
                  </span>
                )}
              </div>
              
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

          {/* User Query Prompts */}
          {outstandingQueries.size > 0 && (
            <div className="p-6 border-b border-gray-200 bg-yellow-50">
              <h2 className="text-lg font-semibold text-yellow-800 mb-4">User Input Required</h2>
              <div className="space-y-4">
                {Array.from(outstandingQueries.values()).map(query => (
                  <div key={query.queryId} className="bg-white rounded-lg border border-yellow-200 p-4 shadow-sm">
                    <div className="mb-3">
                      <span className="text-sm text-gray-600">Agent Question:</span>
                      <p className="text-gray-900 font-medium mt-1">{query.question}</p>
                    </div>
                    <div className="space-y-2">
                      <input
                        type="text"
                        value={query.currentResponse}
                        onChange={(e) => {
                          setOutstandingQueries(prev => {
                            const newQueries = new Map(prev);
                            const existingQuery = newQueries.get(query.queryId);
                            if (existingQuery) {
                              newQueries.set(query.queryId, {
                                ...existingQuery,
                                currentResponse: e.target.value
                              });
                            }
                            return newQueries;
                          });
                        }}
                        className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="Enter your response..."
                      />
                      <div className="flex gap-2">
                        <button
                          onClick={async () => {
                            try {
                              // Send response to agent via client
                              const response = await fetch(`${backendUrl}/api/queries/${query.queryId}/respond`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ response: query.currentResponse })
                              });
                              
                              if (response.ok) {
                                addLog(`Responded to query: "${query.currentResponse}"`, 'success');
                                // Remove the query from outstanding list
                                setOutstandingQueries(prev => {
                                  const newQueries = new Map(prev);
                                  newQueries.delete(query.queryId);
                                  return newQueries;
                                });
                              } else {
                                addLog(`Failed to send response: ${response.statusText}`, 'error');
                              }
                            } catch (error: any) {
                              addLog(`Error sending response: ${error.message}`, 'error');
                            }
                          }}
                          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 transition-colors"
                        >
                          Send Response
                        </button>
                        <button
                          onClick={() => {
                            setOutstandingQueries(prev => {
                              const newQueries = new Map(prev);
                              const existingQuery = newQueries.get(query.queryId);
                              if (existingQuery) {
                                newQueries.set(query.queryId, {
                                  ...existingQuery,
                                  currentResponse: existingQuery.suggestedResponse
                                });
                              }
                              return newQueries;
                            });
                          }}
                          className="px-4 py-2 bg-gray-200 text-gray-700 rounded hover:bg-gray-300 transition-colors"
                        >
                          Reset to Suggestion
                        </button>
                      </div>
                      {query.suggestedResponse && (
                        <p className="text-xs text-gray-500 italic">
                          Suggested: {query.suggestedResponse}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

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
