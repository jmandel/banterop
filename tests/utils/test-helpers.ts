// Test Utilities and Helpers

import { v4 as uuidv4 } from 'uuid';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { HonoWebSocketJsonRpcServer } from '$backend/websocket/hono-websocket-server.js';
import { WebSocketJsonRpcClient } from '$client/impl/websocket.client.js';
import { WebSocket } from 'ws';
import { InProcessOrchestratorClient } from '$client/impl/in-process.client.js';
import { LLMMessage, LLMProvider, LLMRequest, LLMResponse, LLMTool, LLMToolCall, LLMToolResponse } from '../../src/types/llm.types.js';
import {
  StaticReplayConfig, CreateConversationRequest, ConversationEvent,
  AgentId, ConversationTurn, TraceEntry, ThoughtEntry, ToolCallEntry, ToolResultEntry, UserQueryEntry, UserResponseEntry
} from '$lib/types.js';

// Mock LLM Provider for testing
export class MockLLMProvider extends LLMProvider {
  constructor() {
    super({ provider: 'google', apiKey: 'test-key' });
  }

  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    return {
      content: 'Mock response',
      usage: {
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15
      },
      finishReason: 'stop'
    };
  }
  getSupportedModels(): string[] {
    return ['mock-model'];
  }
}

// Helper function to create test orchestrator with mock LLM provider
export function createTestOrchestrator(dbPath: string = ':memory:'): ConversationOrchestrator {
  const mockLLMProvider = new MockLLMProvider();
  return new ConversationOrchestrator(dbPath, mockLLMProvider);
}

// Test Configuration
export const TEST_CONFIG = {
  WEBSOCKET_TIMEOUT: 5000,
  EVENT_WAIT_TIMEOUT: 2000,
  RECONNECT_DELAY: 100,
  DEFAULT_AGENT_SCRIPT: []
};

// Test Environment Setup
export class TestEnvironment {
  public orchestrator: ConversationOrchestrator;
  public wsServer: HonoWebSocketJsonRpcServer;
  public server?: any;
  public httpUrl?: string;
  public wsUrl?: string;

  constructor() {
    // Create a new in-memory database for each test environment instance
    // This ensures complete isolation between tests
    this.orchestrator = createTestOrchestrator(':memory:');
    this.wsServer = new HonoWebSocketJsonRpcServer(this.orchestrator);
  }

  async start(port: number = 0): Promise<void> {
    // Create our own server configuration instead of importing the global one
    const { Hono } = await import('hono');
    const { cors } = await import('hono/cors');
    
    // Create API app
    const apiApp = new Hono();
    apiApp.use('*', cors());
    
    
    // Mount WebSocket routes
    apiApp.route('/ws', this.wsServer.getApp());
    
    // Add basic conversation endpoints for testing
    apiApp.get('/conversations', async (c) => {
      const result = this.orchestrator.getDbInstance().getAllConversations();
      return c.json(result);
    });

    apiApp.post('/conversations', async (c) => {
      const request = await c.req.json();
      const response = await this.orchestrator.createConversation(request);
      return c.json(response);
    });

    apiApp.post('/conversations/:id/start', async (c) => {
      try {
        const conversationId = c.req.param('id');
        await this.orchestrator.startConversation(conversationId);
        return c.json({ success: true, message: 'Conversation started successfully' });
      } catch (error: any) {
        return c.json({ error: error.message }, 400);
      }
    });

    // Query endpoints for E2E testing - specific routes FIRST
    
    // Get all pending queries across the system
    apiApp.get('/queries/pending', async (c) => {
      try {
        const queries = this.orchestrator.getAllPendingUserQueries();
        return c.json({ queries, count: queries.length });
      } catch (error: any) {
        console.error('Error fetching pending queries:', error);
        return c.json({ error: error.message }, 500);
      }
    });

    apiApp.get('/queries/:id', async (c) => {
      try {
        const queryId = c.req.param('id');
        const response = this.orchestrator.getUserQueryStatus(queryId);
        return c.json(response);
      } catch (error: any) {
        return c.json({ error: error.message }, 404);
      }
    });

    apiApp.post('/queries/:id/respond', async (c) => {
      try {
        const queryId = c.req.param('id');
        const { response } = await c.req.json();
        this.orchestrator.respondToUserQuery(queryId, response);
        return c.json({ success: true });
      } catch (error: any) {
        return c.json({ error: error.message }, 400);
      }
    });

    // Get pending queries for a specific conversation
    apiApp.get('/conversations/:id/queries', async (c) => {
      try {
        const conversationId = c.req.param('id');
        const queries = this.orchestrator.getPendingUserQueries(conversationId);
        return c.json({ 
          conversationId, 
          queries, 
          count: queries.length 
        });
      } catch (error: any) {
        console.error('Error fetching conversation queries:', error);
        return c.json({ error: error.message }, 500);
      }
    });

    // Create main app
    const app = new Hono();
    app.route('/api', apiApp);
    
    // Start Bun server
    this.server = Bun.serve({
      port,
      fetch: app.fetch,
      websocket: this.wsServer.getWebSocketHandler(),
    });

    this.httpUrl = `http://localhost:${this.server.port}/api`;
    this.wsUrl = `ws://localhost:${this.server.port}/api/ws`;

  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.stop();
    }
    this.wsServer.close();
  }

  // Create isolated test conversation
  async createTestConversation(name: string, agentCount: number = 1): Promise<{
    conversationId: string;
    agents: Array<{ agentId: string; token: string }>;
  }> {
    const agents: StaticReplayConfig[] = [];
    
    for (let i = 0; i < agentCount; i++) {
      agents.push({
        agentId: { 
          id: `test-agent-${i}`, 
          label: `Test Agent ${i}`, 
          role: 'assistant' 
        } as AgentId,
        strategyType: 'static_replay',
        script: TEST_CONFIG.DEFAULT_AGENT_SCRIPT
      });
    }

    const request: CreateConversationRequest = {
      name,
      agents
    };

    const result = await this.orchestrator.createConversation(request);
    
    return {
      conversationId: result.conversation.id,
      agents: agents.map(agent => ({
        agentId: agent.agentId.id,
        token: result.agentTokens[agent.agentId.id]
      }))
    };
  }
}

// WebSocket Test Client Factory
export class WebSocketTestClient {
  private client: WebSocketJsonRpcClient;
  private events: ConversationEvent[] = [];
  private subscriptions: string[] = [];
  private eventWaiters: Array<{ count: number; resolve: (events: ConversationEvent[]) => void }> = [];
  private predicateWaiters: Array<{ check: () => boolean }> = [];
  private wsUrl: string;

  constructor(wsUrl: string) {
    this.wsUrl = wsUrl;
    this.client = new WebSocketJsonRpcClient(wsUrl);
    this.setupEventCapture();
  }

  private setupEventCapture(): void {
    this.client.on('event', (event: ConversationEvent, subscriptionId: string) => {
      this.events.push(event);
      this.checkEventWaiters();
    });
  }

  private checkEventWaiters(): void {
    // Check if any waiters can be resolved
    for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
      const waiter = this.eventWaiters[i];
      if (this.events.length >= waiter.count) {
        this.eventWaiters.splice(i, 1);
        waiter.resolve([...this.events]);
      }
    }
  }

  async connect(authToken?: string): Promise<void> {
    await this.client.connect(authToken);
  }

  async authenticate(token: string): Promise<any> {
    return this.client.authenticate(token);
  }

  async subscribe(conversationId: string, options?: any): Promise<string> {
    const subscriptionId = await this.client.subscribe(conversationId, options);
    this.subscriptions.push(subscriptionId);
    return subscriptionId;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    await this.client.unsubscribe(subscriptionId);
    const index = this.subscriptions.indexOf(subscriptionId);
    if (index > -1) {
      this.subscriptions.splice(index, 1);
    }
  }

  async waitForEvents(expectedCount: number, timeout: number = TEST_CONFIG.EVENT_WAIT_TIMEOUT): Promise<ConversationEvent[]> {
    return new Promise((resolve, reject) => {
      // Check if we already have enough events
      if (this.events.length >= expectedCount) {
        resolve([...this.events]);
        return;
      }

      const timeoutId = setTimeout(() => {
        // Remove this waiter from the list
        const index = this.eventWaiters.findIndex(w => w.resolve === resolve);
        if (index > -1) {
          this.eventWaiters.splice(index, 1);
        }
        reject(new Error(`Timeout waiting for ${expectedCount} events. Got ${this.events.length}`));
      }, timeout);

      // Add waiter that will be resolved when events arrive
      this.eventWaiters.push({
        count: expectedCount,
        resolve: (events: ConversationEvent[]) => {
          clearTimeout(timeoutId);
          resolve(events);
        }
      });
    });
  }

  getEvents(): ConversationEvent[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events = [];
    // Clear any pending waiters since events were cleared
    this.eventWaiters = [];
    this.predicateWaiters = [];
  }

  async waitForSpecificEvents(
    predicate: (events: ConversationEvent[]) => boolean,
    timeout: number = TEST_CONFIG.EVENT_WAIT_TIMEOUT,
    description?: string
  ): Promise<ConversationEvent[]> {
    return new Promise((resolve, reject) => {
      // Check if we already satisfy the condition
      if (predicate(this.events)) {
        resolve([...this.events]);
        return;
      }

      const timeoutId = setTimeout(() => {
        const desc = description || 'specific events';
        reject(new Error(`Timeout waiting for ${desc}. Got ${this.events.length} events: ${this.events.map(e => e.type).join(', ')}`));
      }, timeout);

      // Create a custom waiter that checks the predicate
      const checkPredicate = () => {
        if (predicate(this.events)) {
          clearTimeout(timeoutId);
          resolve([...this.events]);
          return true;
        }
        return false;
      };

      // Add to predicate waiter list
      this.predicateWaiters.push({ check: checkPredicate });
    });
  }

  async disconnect(): Promise<void> {
    // Clean up subscriptions
    for (const subscriptionId of this.subscriptions) {
      try {
        await this.client.unsubscribe(subscriptionId);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    this.client.disconnect();
  }

  // Delegate methods to underlying client
  async startTurn(metadata?: Record<string, any>): Promise<string> {
    return this.client.startTurn(metadata);
  }

  async addTrace(turnId: string, entry: Omit<TraceEntry, 'id' | 'timestamp' | 'agentId'>): Promise<void> {
    return this.client.addTrace(turnId, entry);
  }

  async completeTurn(turnId: string, content: string, isFinalTurn?: boolean, metadata?: Record<string, any>, attachments?: string[]): Promise<ConversationTurn> {
    return this.client.completeTurn(turnId, content, isFinalTurn, metadata, attachments);
  }

  // Helper method for backward compatibility with old submitTurn pattern
  async submitTurn(content: string, trace: TraceEntry[]): Promise<ConversationTurn> {
    const turnId = await this.startTurn();
    
    // Add trace entries
    for (const entry of trace) {
      let partialEntry: Omit<TraceEntry, 'id' | 'timestamp' | 'agentId'>;
      
      switch (entry.type) {
        case 'thought':
          partialEntry = {
            type: 'thought',
            content: (entry as ThoughtEntry).content
          } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>;
          break;
        case 'tool_call':
          const toolCallEntry = entry as ToolCallEntry;
          partialEntry = {
            type: 'tool_call',
            toolName: toolCallEntry.toolName,
            parameters: toolCallEntry.parameters,
            toolCallId: toolCallEntry.toolCallId
          } as Omit<ToolCallEntry, 'id' | 'timestamp' | 'agentId'>;
          break;
        case 'tool_result':
          const toolResultEntry = entry as ToolResultEntry;
          partialEntry = {
            type: 'tool_result',
            toolCallId: toolResultEntry.toolCallId,
            result: toolResultEntry.result
          } as Omit<ToolResultEntry, 'id' | 'timestamp' | 'agentId'>;
          break;
        case 'user_query':
          const userQueryEntry = entry as UserQueryEntry;
          partialEntry = {
            type: 'user_query',
            queryId: userQueryEntry.queryId,
            question: userQueryEntry.question,
            context: userQueryEntry.context
          } as Omit<UserQueryEntry, 'id' | 'timestamp' | 'agentId'>;
          break;
        case 'user_response':
          const userResponseEntry = entry as UserResponseEntry;
          partialEntry = {
            type: 'user_response',
            queryId: userResponseEntry.queryId,
            response: userResponseEntry.response
          } as Omit<UserResponseEntry, 'id' | 'timestamp' | 'agentId'>;
          break;
        default:
          throw new Error(`Unknown trace entry type: ${(entry as any).type}`);
      }
      
      await this.addTrace(turnId, partialEntry);
    }
    
    return this.completeTurn(turnId, content);
  }

  async createUserQuery(question: string, context?: Record<string, any>, timeout?: number): Promise<string> {
    return this.client.createUserQuery(question, context, timeout);
  }

  async respondToUserQuery(queryId: string, response: string): Promise<void> {
    return this.client.respondToUserQuery(queryId, response);
  }

  async getConversation(conversationId?: string, options?: any): Promise<any> {
    return this.client.getConversation(conversationId, options);
  }

  async getAllConversations(options?: { 
    limit?: number; 
    offset?: number; 
    includeTurns?: boolean; 
    includeTrace?: boolean;
  }): Promise<{ conversations: any[]; total: number; limit: number; offset: number }> {
    return this.client.getAllConversations(options);
  }

  // EventEmitter interface delegation (already handled in setupEventCapture, but adding for completeness)
  on(event: string, listener: (...args: any[]) => void): this {
    this.client.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.client.off(event, listener);
    return this;
  }

  listenerCount(event: string): number {
    return this.client.listenerCount(event);
  }

  async simulateReconnect(): Promise<void> {
    // Force a disconnect by calling the internal websocket close with a non-1000 code
    // This simulates an abnormal closure which should trigger reconnection
    const ws = (this.client as any).ws;
    if (ws && ws.close) {
      // Use code 1006 (abnormal closure) to trigger reconnection
      ws.close(1006, 'Test disconnect');
    } else {
      throw new Error('No WebSocket found to close');
    }
    
    // Wait for the client to reconnect automatically
    await waitForCondition(() => this.client.getConnectionState() === 'ready', 10000);
  }

  async registerAttachment(params: {
    conversationId: string;
    turnId: string;
    docId?: string;
    name: string;
    contentType: string;
    content: string;
    summary?: string;
    createdByAgentId: string;
  }): Promise<string> {
    return this.client.registerAttachment(params);
  }

  getConnectionState(): 'disconnected' | 'connecting' | 'rehydrating' | 'ready' {
    return this.client.getConnectionState();
  }
}

// In-Process Test Client Factory
export class InProcessTestClient {
  private client: InProcessOrchestratorClient;
  private events: ConversationEvent[] = [];
  private subscriptions: string[] = [];
  private eventWaiters: Array<{ count: number; resolve: (events: ConversationEvent[]) => void }> = [];
  private predicateWaiters: Array<{ check: () => boolean }> = [];

  constructor(orchestrator: ConversationOrchestrator) {
    this.client = new InProcessOrchestratorClient(orchestrator);
    this.setupEventCapture();
  }

  private setupEventCapture(): void {
    this.client.on('event', (event: ConversationEvent, subscriptionId: string) => {
      this.events.push(event);
      this.checkEventWaiters();
    });
  }

  private checkEventWaiters(): void {
    // Check if any waiters can be resolved
    for (let i = this.eventWaiters.length - 1; i >= 0; i--) {
      const waiter = this.eventWaiters[i];
      if (this.events.length >= waiter.count) {
        this.eventWaiters.splice(i, 1);
        waiter.resolve([...this.events]);
      }
    }
    
    // Check if any predicate-based waiters can be resolved
    for (let i = this.predicateWaiters.length - 1; i >= 0; i--) {
      if (this.predicateWaiters[i].check()) {
        this.predicateWaiters.splice(i, 1);
      }
    }
  }

  async connect(authToken?: string): Promise<void> {
    await this.client.connect(authToken);
  }

  async authenticate(token: string): Promise<any> {
    return this.client.authenticate(token);
  }

  async subscribe(conversationId: string, options?: any): Promise<string> {
    const subscriptionId = await this.client.subscribe(conversationId, options);
    this.subscriptions.push(subscriptionId);
    return subscriptionId;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    await this.client.unsubscribe(subscriptionId);
    const index = this.subscriptions.indexOf(subscriptionId);
    if (index > -1) {
      this.subscriptions.splice(index, 1);
    }
  }

  async waitForEvents(expectedCount: number, timeout: number = TEST_CONFIG.EVENT_WAIT_TIMEOUT): Promise<ConversationEvent[]> {
    return new Promise((resolve, reject) => {
      // Check if we already have enough events
      if (this.events.length >= expectedCount) {
        resolve([...this.events]);
        return;
      }

      const timeoutId = setTimeout(() => {
        // Remove this waiter from the list
        const index = this.eventWaiters.findIndex(w => w.resolve === resolve);
        if (index > -1) {
          this.eventWaiters.splice(index, 1);
        }
        reject(new Error(`Timeout waiting for ${expectedCount} events. Got ${this.events.length}`));
      }, timeout);

      // Add waiter that will be resolved when events arrive
      this.eventWaiters.push({
        count: expectedCount,
        resolve: (events: ConversationEvent[]) => {
          clearTimeout(timeoutId);
          resolve(events);
        }
      });
    });
  }

  getEvents(): ConversationEvent[] {
    return [...this.events];
  }

  clearEvents(): void {
    this.events = [];
    // Clear any pending waiters since events were cleared
    this.eventWaiters = [];
    this.predicateWaiters = [];
  }

  async waitForSpecificEvents(
    predicate: (events: ConversationEvent[]) => boolean,
    timeout: number = TEST_CONFIG.EVENT_WAIT_TIMEOUT,
    description?: string
  ): Promise<ConversationEvent[]> {
    return new Promise((resolve, reject) => {
      // Check if we already satisfy the condition
      if (predicate(this.events)) {
        resolve([...this.events]);
        return;
      }

      const timeoutId = setTimeout(() => {
        const desc = description || 'specific events';
        reject(new Error(`Timeout waiting for ${desc}. Got ${this.events.length} events: ${this.events.map(e => e.type).join(', ')}`));
      }, timeout);

      // Create a custom waiter that checks the predicate
      const checkPredicate = () => {
        if (predicate(this.events)) {
          clearTimeout(timeoutId);
          resolve([...this.events]);
          return true;
        }
        return false;
      };

      // Add to predicate waiter list
      this.predicateWaiters.push({ check: checkPredicate });
    });
  }

  async disconnect(): Promise<void> {
    // Clean up subscriptions
    for (const subscriptionId of this.subscriptions) {
      try {
        await this.client.unsubscribe(subscriptionId);
      } catch (error) {
        // Ignore cleanup errors
      }
    }
    this.client.disconnect();
  }

  // Delegate methods to underlying client
  async startTurn(metadata?: Record<string, any>): Promise<string> {
    return this.client.startTurn(metadata);
  }

  async addTrace(turnId: string, entry: Omit<TraceEntry, 'id' | 'timestamp' | 'agentId'>): Promise<void> {
    return this.client.addTrace(turnId, entry);
  }

  async completeTurn(turnId: string, content: string, isFinalTurn?: boolean, metadata?: Record<string, any>, attachments?: string[]): Promise<ConversationTurn> {
    return this.client.completeTurn(turnId, content, isFinalTurn, metadata, attachments);
  }

  // Helper method for backward compatibility with old submitTurn pattern
  async submitTurn(content: string, trace: TraceEntry[]): Promise<ConversationTurn> {
    const turnId = await this.startTurn();
    
    // Add trace entries
    for (const entry of trace) {
      let partialEntry: Omit<TraceEntry, 'id' | 'timestamp' | 'agentId'>;
      
      switch (entry.type) {
        case 'thought':
          partialEntry = {
            type: 'thought',
            content: (entry as ThoughtEntry).content
          } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>;
          break;
        case 'tool_call':
          const toolCallEntry = entry as ToolCallEntry;
          partialEntry = {
            type: 'tool_call',
            toolName: toolCallEntry.toolName,
            parameters: toolCallEntry.parameters,
            toolCallId: toolCallEntry.toolCallId
          } as Omit<ToolCallEntry, 'id' | 'timestamp' | 'agentId'>;
          break;
        case 'tool_result':
          const toolResultEntry = entry as ToolResultEntry;
          partialEntry = {
            type: 'tool_result',
            toolCallId: toolResultEntry.toolCallId,
            result: toolResultEntry.result
          } as Omit<ToolResultEntry, 'id' | 'timestamp' | 'agentId'>;
          break;
        case 'user_query':
          const userQueryEntry = entry as UserQueryEntry;
          partialEntry = {
            type: 'user_query',
            queryId: userQueryEntry.queryId,
            question: userQueryEntry.question,
            context: userQueryEntry.context
          } as Omit<UserQueryEntry, 'id' | 'timestamp' | 'agentId'>;
          break;
        case 'user_response':
          const userResponseEntry = entry as UserResponseEntry;
          partialEntry = {
            type: 'user_response',
            queryId: userResponseEntry.queryId,
            response: userResponseEntry.response
          } as Omit<UserResponseEntry, 'id' | 'timestamp' | 'agentId'>;
          break;
        default:
          throw new Error(`Unknown trace entry type: ${(entry as any).type}`);
      }
      
      await this.addTrace(turnId, partialEntry);
    }
    
    return this.completeTurn(turnId, content);
  }

  async createUserQuery(question: string, context?: Record<string, any>, timeout?: number): Promise<string> {
    return this.client.createUserQuery(question, context, timeout);
  }

  async respondToUserQuery(queryId: string, response: string): Promise<void> {
    return this.client.respondToUserQuery(queryId, response);
  }

  async getConversation(conversationId?: string, options?: any): Promise<any> {
    return this.client.getConversation(conversationId, options);
  }

  // EventEmitter interface delegation
  on(event: string, listener: (...args: any[]) => void): this {
    this.client.on(event, listener);
    return this;
  }

  off(event: string, listener: (...args: any[]) => void): this {
    this.client.off(event, listener);
    return this;
  }

  listenerCount(event: string): number {
    return this.client.listenerCount(event);
  }

  // Expose agent ID for test access
  get agentId(): string | undefined {
    return (this.client as any).agentId;
  }
}

// Test Data Factories
export class TestDataFactory {
  static createAgentId(id?: string): AgentId {
    return {
      id: id || `agent-${uuidv4()}`,
      label: `Test Agent ${id || 'Auto'}`,
      role: 'assistant'
    };
  }

  static createStaticReplayConfig(agentId?: AgentId, script?: any[]): StaticReplayConfig {
    return {
      agentId: agentId || TestDataFactory.createAgentId(),
      strategyType: 'static_replay',
      script: script || TEST_CONFIG.DEFAULT_AGENT_SCRIPT
    };
  }

  // For addTrace method (partial trace entry)
  static createTraceEntryPartial(type: 'thought' | 'tool_call' | 'tool_result', content?: any): Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'> | Omit<ToolCallEntry, 'id' | 'timestamp' | 'agentId'> | Omit<ToolResultEntry, 'id' | 'timestamp' | 'agentId'> {
    switch (type) {
      case 'thought':
        return {
          type: 'thought',
          content: content || 'Test thought entry'
        } as Omit<ThoughtEntry, 'id' | 'timestamp' | 'agentId'>;
      case 'tool_call':
        return {
          type: 'tool_call',
          toolName: content?.toolName || 'test_tool',
          parameters: content?.parameters || { input: 'test' },
          toolCallId: content?.toolCallId || `call-${uuidv4()}`
        } as Omit<ToolCallEntry, 'id' | 'timestamp' | 'agentId'>;
      case 'tool_result':
        return {
          type: 'tool_result',
          toolCallId: content?.toolCallId || `call-${uuidv4()}`,
          result: content?.result || 'Test result'
        } as Omit<ToolResultEntry, 'id' | 'timestamp' | 'agentId'>;
    }
  }

  // For submitTurn method (complete trace entry)
  static createTraceEntry(type: 'thought' | 'tool_call' | 'tool_result', content?: any): TraceEntry {
    const baseEntry = {
      id: uuidv4(),
      agentId: 'test-agent-0',
      timestamp: new Date()
    };

    switch (type) {
      case 'thought':
        return {
          ...baseEntry,
          type: 'thought',
          content: content || 'Test thought entry'
        } as ThoughtEntry;
      case 'tool_call':
        return {
          ...baseEntry,
          type: 'tool_call',
          toolName: content?.toolName || 'test_tool',
          parameters: content?.parameters || { input: 'test' },
          toolCallId: content?.toolCallId || `call-${uuidv4()}`
        } as ToolCallEntry;
      case 'tool_result':
        return {
          ...baseEntry,
          type: 'tool_result',
          toolCallId: content?.toolCallId || `call-${uuidv4()}`,
          result: content?.result || 'Test result'
        } as ToolResultEntry;
    }
  }
}

// Assertion Helpers
export class TestAssertions {
  static assertEventType(event: ConversationEvent, expectedType: string): void {
    if (event.type !== expectedType) {
      throw new Error(`Expected event type '${expectedType}', got '${event.type}'`);
    }
  }

  static assertEventHasData(event: ConversationEvent): void {
    if (!event.data) {
      throw new Error(`Event '${event.type}' missing data field`);
    }
  }

  static assertTurnContent(turn: ConversationTurn, expectedContent: string): void {
    if (turn.content !== expectedContent) {
      throw new Error(`Expected turn content '${expectedContent}', got '${turn.content}'`);
    }
  }

  static assertTraceLength(turn: ConversationTurn, expectedLength: number): void {
    const actualLength = turn.trace?.length || 0;
    if (actualLength !== expectedLength) {
      throw new Error(`Expected trace length ${expectedLength}, got ${actualLength}`);
    }
  }
}

// Async Test Utilities
export const waitForCondition = async (
  condition: () => boolean | Promise<boolean>,
  timeout: number = TEST_CONFIG.EVENT_WAIT_TIMEOUT,
  interval: number = 10
): Promise<void> => {
  const start = Date.now();
  
  while (Date.now() - start < timeout) {
    if (await condition()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  
  throw new Error(`Condition not met within ${timeout}ms`);
};

export const delay = (ms: number): Promise<void> => {
  return new Promise(resolve => setTimeout(resolve, ms));
};
