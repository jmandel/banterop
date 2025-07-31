// External Agent Executor - In-Browser Agent Runtime Demo
import React, { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { WebSocketJsonRpcClient } from '../../client/impl/websocket.client.js';
import type { 
  ScenarioConfiguration, 
  ConversationEvent, 
  AgentId,
  LLMRequest,
  LLMResponse,
  Tool,
  TraceEntry,
  ConversationTurn,
  ThoughtEntry,
  ToolCallEntry,
  ToolResultEntry
} from '$lib/types.js';

// =============================================================================
// BROWSER-COMPATIBLE MOCK IMPLEMENTATIONS
// =============================================================================

/**
 * Browser-compatible mock LLM provider that provides predictable responses
 * for demo purposes. This replaces the Node.js LLMProvider.
 */
class MockLLMProvider {
  private config: any;

  constructor(config = { provider: 'mock', apiKey: 'browser-mock' }) {
    this.config = config;
  }

  async generateContent(request: LLMRequest): Promise<LLMResponse> {
    // Simple mock response that alternates between sending a message and ending
    const shouldEnd = Math.random() < 0.3; // 30% chance to end conversation
    
    if (shouldEnd) {
      // Use a terminal tool to end the conversation
      return {
        content: `<scratchpad>
Based on the conversation flow, I should now complete this authorization process.
</scratchpad>

\`\`\`json
{
  "name": "mri_authorization_Success",
  "args": {
    "authNumber": "AUTH-${Date.now()}"
  }
}
\`\`\``
      };
    } else {
      // Send a message to continue the conversation
      return {
        content: `<scratchpad>
I need to respond to continue this healthcare workflow conversation.
</scratchpad>

\`\`\`json
{
  "name": "send_message_to_thread",
  "args": {
    "text": "I'm processing your request. Let me review the documentation and get back to you with next steps."
  }
}
\`\`\``
      };
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
 * Browser-compatible mock database that holds scenario data in memory
 */
class MockDatabase {
  private scenario: ScenarioConfiguration;

  constructor(scenarioConfig: ScenarioConfiguration) {
    this.scenario = scenarioConfig;
  }

  findScenarioByIdAndVersion(scenarioId: string, versionId?: string): ScenarioConfiguration | null {
    if (this.scenario.metadata.id === scenarioId) {
      return this.scenario;
    }
    return null;
  }
}

/**
 * Browser-compatible mock tool synthesis service
 */
class MockToolSynthesisService {
  private llm: MockLLMProvider;

  constructor(llm: MockLLMProvider) {
    this.llm = llm;
  }

  async synthesizeToolResult(toolName: string, parameters: any, toolDefinition?: Tool): Promise<any> {
    // Generate mock results based on tool name
    if (toolName.includes('Success') || toolName.includes('Approval')) {
      return {
        status: 'success',
        result: `Successfully executed ${toolName}`,
        timestamp: new Date().toISOString()
      };
    } else if (toolName.includes('Failure') || toolName.includes('Denial')) {
      return {
        status: 'denied',
        reason: `Request denied by ${toolName}`,
        timestamp: new Date().toISOString()
      };
    } else {
      return {
        status: 'processed',
        data: parameters,
        message: `Tool ${toolName} executed successfully`,
        timestamp: new Date().toISOString()
      };
    }
  }
}

/**
 * Browser-compatible ScenarioDrivenAgent
 * Simplified version that works in the browser environment
 */
class BrowserScenarioAgent {
  private agentId: AgentId;
  private client: WebSocketJsonRpcClient;
  private scenario: ScenarioConfiguration;
  private role: 'PatientAgent' | 'SupplierAgent';
  private llm: MockLLMProvider;
  private toolSynthesis: MockToolSynthesisService;
  private conversationId?: string;
  private isReady = false;
  private processingTurn = false;
  private playbackSpeedMs = 5000; // Default 5 seconds

  constructor(
    config: { agentId: AgentId; role: 'PatientAgent' | 'SupplierAgent' },
    client: WebSocketJsonRpcClient,
    scenario: ScenarioConfiguration,
    llm: MockLLMProvider,
    toolSynthesis: MockToolSynthesisService
  ) {
    this.agentId = config.agentId;
    this.client = client;
    this.scenario = scenario;
    this.role = config.role;
    this.llm = llm;
    this.toolSynthesis = toolSynthesis;

    // Set up event handlers
    this.client.on('event', (event: ConversationEvent) => {
      console.log(`${this.role} received event:`, event.type, event.data);
      if (event.type === 'turn_completed' && this.isReady) {
        console.log(`${this.role} will process turn_completed event`);
        this.onTurnCompleted(event);
      }
    });
  }

  async initialize(conversationId: string, token: string): Promise<void> {
    this.conversationId = conversationId;
    
    // Connect and authenticate in one call
    await this.client.connect(token);
    await this.client.subscribe(conversationId);
    
    this.isReady = true;
    console.log(`${this.role} initialized and connected`);
  }

  setPlaybackSpeed(speedMs: number): void {
    this.playbackSpeedMs = speedMs;
    console.log(`${this.role} playback speed set to ${speedMs}ms`);
  }

  private async onTurnCompleted(event: any): Promise<void> {
    console.log(`${this.role} onTurnCompleted called for turn from ${event.data.turn.agentId}`);
    
    // Skip if it's our own turn or if already processing
    if (event.data.turn.agentId === this.agentId.id || this.processingTurn) {
      console.log(`${this.role} skipping - own turn or already processing`);
      return;
    }

    // Skip if this is a final turn
    if (event.data.turn.isFinalTurn) {
      console.log(`${this.role} skipping final turn processing`);
      return;
    }

    this.processingTurn = true;
    
    try {
      console.log(`${this.role} waiting ${this.playbackSpeedMs}ms before processing turn...`);
      const startTime = Date.now();
      
      // Add configurable delay before processing
      await new Promise(resolve => setTimeout(resolve, this.playbackSpeedMs));
      
      const actualDelay = Date.now() - startTime;
      console.log(`${this.role} waited ${actualDelay}ms, now processing turn from ${event.data.turn.agentId}`);
      
      // Get agent configuration
      const agentConfig = this.scenario.agents.find(a => a.agentId.id === this.agentId.id);
      if (!agentConfig) {
        console.error(`Agent configuration not found for ${this.agentId.id}`);
        return;
      }
      
      // Create a simple prompt for the LLM
      const prompt = this.buildSimplePrompt(agentConfig, event.data.turn.content);
      
      // Get LLM response
      const response = await this.llm.generateContent({
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.1,
        maxTokens: 1500
      });
      
      // Parse tool call from response
      const toolCall = this.parseToolCall(response.content);
      
      if (toolCall) {
        await this.executeTool(toolCall);
      }
      
    } catch (error) {
      console.error(`${this.role} error processing turn:`, error);
    } finally {
      this.processingTurn = false;
    }
  }

  private buildSimplePrompt(agentConfig: any, lastMessage: string): string {
    const tools = agentConfig.tools.map((tool: Tool) => `- ${tool.toolName}: ${tool.description}`).join('\n');
    
    return `You are ${this.role} representing ${agentConfig.principalIdentity}.

Your instructions: ${agentConfig.systemPrompt}

Available tools:
${tools}

Last message in conversation: "${lastMessage}"

Respond with your action in this format:

<scratchpad>
[Your reasoning here]
</scratchpad>

\`\`\`json
{
  "name": "tool_name",
  "args": { "parameter": "value" }
}
\`\`\``;
  }

  private parseToolCall(content: string): { tool: string; parameters: any } | null {
    try {
      const jsonMatch = content.match(/```json\s*([\s\S]*?)\s*```/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[1]);
        return {
          tool: parsed.name,
          parameters: parsed.args || {}
        };
      }
    } catch (error) {
      console.error('Failed to parse tool call:', error);
    }
    return null;
  }

  private async executeTool(toolCall: { tool: string; parameters: any }): Promise<void> {
    console.log(`${this.role} executing tool: ${toolCall.tool}`);
    
    // Handle built-in communication tools
    if (toolCall.tool === 'send_message_to_thread') {
      const turnId = await this.client.startTurn();
      await this.client.addTrace(turnId, {
        type: 'thought',
        content: `Sending message to conversation thread`
      } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>);
      
      console.log(`${this.role} waiting ${this.playbackSpeedMs}ms before completing turn...`);
      await new Promise(resolve => setTimeout(resolve, this.playbackSpeedMs));
      
      const isTerminal = this.isTerminalTool(toolCall.tool);
      await this.client.completeTurn(turnId, toolCall.parameters.text, isTerminal);
      return;
    }

    if (toolCall.tool === 'send_message_to_principal') {
      await this.client.createUserQuery(toolCall.parameters.text);
      console.log(`${this.role} created user query: ${toolCall.parameters.text}`);
      return;
    }

    // Handle other tools with synthesis
    const turnId = await this.client.startTurn();
    
    await this.client.addTrace(turnId, {
      type: 'thought',
      content: `Executing ${toolCall.tool}`
    } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>);
    
    await this.client.addTrace(turnId, {
      type: 'tool_call',
      toolName: toolCall.tool,
      parameters: toolCall.parameters,
      toolCallId: `call-${Date.now()}`
    } as Omit<ToolCallEntry, 'id' | 'timestamp' | 'agentId'>);
    
    try {
      const result = await this.toolSynthesis.synthesizeToolResult(toolCall.tool, toolCall.parameters);
      
      await this.client.addTrace(turnId, {
        type: 'tool_result',
        toolCallId: `call-${Date.now()}`,
        result: result
      } as Omit<ToolResultEntry, 'id' | 'timestamp' | 'agentId'>);
      
      const isTerminal = this.isTerminalTool(toolCall.tool);
      const message = isTerminal 
        ? `Process completed: ${JSON.stringify(result)}`
        : `I executed ${toolCall.tool} and got: ${JSON.stringify(result)}`;
      
      console.log(`${this.role} waiting ${this.playbackSpeedMs}ms before completing turn...`);
      await new Promise(resolve => setTimeout(resolve, this.playbackSpeedMs));
        
      await this.client.completeTurn(turnId, message, isTerminal);
      
      if (isTerminal) {
        console.log(`${this.role} used terminal tool, conversation should end`);
      }
      
    } catch (error: any) {
      await this.client.addTrace(turnId, {
        type: 'tool_result',
        toolCallId: `call-${Date.now()}`,
        result: null,
        error: error.message
      } as Omit<ToolResultEntry, 'id' | 'timestamp' | 'agentId'>);
      
      console.log(`${this.role} waiting ${this.playbackSpeedMs}ms before completing error turn...`);
      await new Promise(resolve => setTimeout(resolve, this.playbackSpeedMs));
      
      await this.client.completeTurn(turnId, `Error executing ${toolCall.tool}: ${error.message}`);
    }
  }

  private isTerminalTool(toolName: string): boolean {
    return ['Success', 'Approval', 'Failure', 'Denial', 'NoSlots'].some(suffix => 
      toolName.endsWith(suffix)
    );
  }

  async startInitialTurn(message: string): Promise<void> {
    console.log(`${this.role} waiting ${this.playbackSpeedMs}ms before starting initial turn...`);
    await new Promise(resolve => setTimeout(resolve, this.playbackSpeedMs));
    
    const turnId = await this.client.startTurn();
    await this.client.addTrace(turnId, {
      type: 'thought',
      content: 'Starting the conversation as requested'
    } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>);
    await this.client.completeTurn(turnId, message);
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
  const [agents, setAgents] = useState<BrowserScenarioAgent[]>([]);
  const [conversationId, setConversationId] = useState<string>('');
  const [promptedQueries, setPromptedQueries] = useState<Set<string>>(new Set());
  const [playbackSpeed, setPlaybackSpeed] = useState<number>(5000); // Default 5 seconds
  const [autoScroll, setAutoScroll] = useState<boolean>(true);
  
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
      agents.forEach(agent => {
        agent.setPlaybackSpeed(newSpeed);
      });
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
      const scenarioConfig = scenarioData.data.config;
      addLog('Successfully fetched scenario configuration');

      // Step 2: Create conversation with external management mode
      addLog('Creating external conversation...');
      const createRes = await fetch('http://localhost:3001/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Live In-Browser External Agent Demo',
          managementMode: 'external',
          agents: [
            {
              agentId: { id: 'browser-patient', label: 'Browser Patient Agent', role: 'PatientAgent' },
              strategyType: 'scenario_driven',
              scenarioId: KNEE_MRI_SCENARIO_ID,
              role: 'PatientAgent'
            },
            {
              agentId: { id: 'browser-supplier', label: 'Browser Supplier Agent', role: 'SupplierAgent' },
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
      
      // Step 5: Create browser scenario agents
      const patientAgent = new BrowserScenarioAgent(
        { agentId: { id: 'browser-patient', label: 'Browser Patient Agent', role: 'PatientAgent' }, role: 'PatientAgent' },
        patientClient,
        scenarioConfig,
        mockLlm,
        mockToolSynthesis
      );
      
      const supplierAgent = new BrowserScenarioAgent(
        { agentId: { id: 'browser-supplier', label: 'Browser Supplier Agent', role: 'SupplierAgent' }, role: 'SupplierAgent' },
        supplierClient,
        scenarioConfig,
        mockLlm,
        mockToolSynthesis
      );
      
      addLog('In-browser agent objects created');

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
        patientAgent.initialize(conversation.id, agentTokens['browser-patient']),
        supplierAgent.initialize(conversation.id, agentTokens['browser-supplier'])
      ]);
      
      setAgents([patientAgent, supplierAgent]);
      
      // Set initial playback speed
      patientAgent.setPlaybackSpeed(playbackSpeed);
      supplierAgent.setPlaybackSpeed(playbackSpeed);
      
      addLog('Both agents initialized and connected via WebSocket');

      // Step 8: Start the conversation by having the patient agent send the first turn
      // This activates the external conversation
      await patientAgent.startInitialTurn(
        "Hello, I'm following up on the prior authorization request for my right knee MRI."
      );
      
      addLog('Patient agent sent the first turn. Conversation is now active');
      addLog('Demo running... Watch for agent interactions and user queries');
      
    } catch (error: any) {
      addLog(`Error: ${error.message}`, 'error');
      setIsLoading(false);
    }
  };

  const stopDemo = () => {
    // Disconnect all agents
    agents.forEach(agent => {
      try {
        (agent as any).client?.disconnect();
      } catch (error) {
        console.error('Error disconnecting agent:', error);
      }
    });
    
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