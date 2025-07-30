// Hono WebSocket JSON-RPC Server Implementation

import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import { v4 as uuidv4 } from 'uuid';
import type { ServerWebSocket } from 'bun';
import { ConversationOrchestrator } from '../core/orchestrator.js';
import {
  ConversationEvent, SubscriptionOptions, StartTurnRequest,
  AddTraceEntryRequest, CompleteTurnRequest,
  UserQueryRequest, TraceEntry, CreateConversationRequest
} from '$lib/types.js';

// ============= JSON-RPC Types =============

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: any;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number;
  result?: any;
  error?: JsonRpcError;
}

interface JsonRpcError {
  code: number;
  message: string;
  data?: any;
}

interface JsonRpcNotification {
  jsonrpc: '2.0';
  method: string;
  params?: any;
}

// Error codes
const RPC_ERRORS = {
  PARSE_ERROR: { code: -32700, message: 'Parse error' },
  INVALID_REQUEST: { code: -32600, message: 'Invalid Request' },
  METHOD_NOT_FOUND: { code: -32601, message: 'Method not found' },
  INVALID_PARAMS: { code: -32602, message: 'Invalid params' },
  INTERNAL_ERROR: { code: -32603, message: 'Internal error' },
  
  // Custom errors
  UNAUTHORIZED: { code: -32000, message: 'Unauthorized' },
  CONVERSATION_NOT_FOUND: { code: -32001, message: 'Conversation not found' },
  INVALID_TOKEN: { code: -32002, message: 'Invalid token' },
  SUBSCRIPTION_FAILED: { code: -32003, message: 'Subscription failed' }
};

// ============= WebSocket Client State =============

interface ClientState {
  id: string;
  ws: ServerWebSocket;
  authenticated: boolean;
  conversationId?: string;
  agentId?: string;
  subscriptions: Map<string, () => void>; // subscriptionId -> unsubscribe function
}

// ============= Hono WebSocket JSON-RPC Server =============

export class HonoWebSocketJsonRpcServer {
  private orchestrator: ConversationOrchestrator;
  private clients: Map<string, ClientState>;
  private wsToClientId: Map<any, string>;
  private methods: Map<string, (client: ClientState, params: any) => Promise<any>>;
  private app: Hono;
  private websocket: any;

  constructor(orchestrator: ConversationOrchestrator) {
    console.log('[WS Server] Initializing HonoWebSocketJsonRpcServer');
    this.orchestrator = orchestrator;
    this.clients = new Map();
    this.wsToClientId = new Map();
    this.methods = new Map();
    
    console.log('[WS Server] Creating Bun WebSocket handlers');
    const { upgradeWebSocket, websocket } = createBunWebSocket<ServerWebSocket>();
    this.websocket = websocket;
    this.app = new Hono();
    console.log('[WS Server] Hono app created');
    
    this.setupMethods();
    console.log('[WS Server] Methods set up, count:', this.methods.size);
    this.setupWebSocketRoute(upgradeWebSocket);
    console.log('[WS Server] WebSocket route configured');
  }

  private setupMethods() {
    // Authentication
    this.methods.set('authenticate', this.authenticate.bind(this));
    
    // Conversation lifecycle
    this.methods.set('createConversation', this.createConversation.bind(this));
    this.methods.set('startConversation', this.startConversation.bind(this));
    
    // Subscriptions
    this.methods.set('subscribe', this.subscribe.bind(this));
    this.methods.set('unsubscribe', this.unsubscribe.bind(this));
    this.methods.set('unsubscribeAll', this.unsubscribeAll.bind(this));
    
    // Turn management
    this.methods.set('startTurn', this.startTurn.bind(this));
    this.methods.set('addTrace', this.addTrace.bind(this));
    this.methods.set('completeTurn', this.completeTurn.bind(this));
    
    // User queries
    this.methods.set('createUserQuery', this.createUserQuery.bind(this));
    this.methods.set('respondToUserQuery', this.respondToUserQuery.bind(this));
    this.methods.set('getPendingUserQueries', this.getPendingUserQueries.bind(this));
    this.methods.set('getAllPendingUserQueries', this.getAllPendingUserQueries.bind(this));
    
    // Conversation info
    this.methods.set('getConversation', this.getConversation.bind(this));
    this.methods.set('getAllConversations', this.getAllConversations.bind(this));
  }

  private setupWebSocketRoute(upgradeWebSocket: any) {
    console.log('[WS Server] Setting up WebSocket route at "/"');
    this.app.get('/', upgradeWebSocket((c) => {
      console.log('[WS Server] WebSocket upgrade requested, creating handlers');
      return {
        onOpen: (event, ws) => {
          console.log('[WS Server] WebSocket connection opened');
          this.handleConnection(ws);
        },
        onMessage: (event, ws) => {
          console.log('[WS Server] WebSocket message received:', event.data?.toString()?.substring(0, 100));
          this.handleMessage(ws, event.data);
        },
        onClose: (event, ws) => {
          console.log('[WS Server] WebSocket connection closed, code:', event.code, 'reason:', event.reason);
          this.handleDisconnect(ws);
        },
        onError: (event, ws) => {
          console.error('[WS Server] WebSocket error:', event);
        }
      };
    }));
    console.log('[WS Server] WebSocket route setup complete');
  }

  private handleConnection(ws: ServerWebSocket) {
    const clientId = uuidv4();
    console.log(`[WS Server] New client connecting, assigned ID: ${clientId}`);
    
    const client: ClientState = {
      id: clientId,
      ws,
      authenticated: false,
      subscriptions: new Map()
    };
    
    // Store client mapping using the underlying raw WebSocket for reliable tracking
    this.clients.set(clientId, client);
    this.wsToClientId.set((ws as any).raw, clientId);
    console.log(`[WS Server] Client ${clientId} connected successfully, total clients:`, this.clients.size);
  }

  private async handleMessage(ws: ServerWebSocket, data: string | Buffer) {
    const client = this.findClientByWebSocket(ws);
    if (!client) {
      console.error('[WS Server] Received message from unknown client');
      return;
    }

    console.log(`[WS Server] Processing message from client ${client.id}`);
    try {
      const message = JSON.parse(data.toString());
      console.log(`[WS Server] Parsed JSON-RPC message:`, message.method || 'notification');
      await this.processMessage(client, message);
    } catch (error) {
      console.error('[WS Server] JSON parse error:', error);
      this.sendError(ws, null, RPC_ERRORS.PARSE_ERROR);
    }
  }

  private async processMessage(client: ClientState, message: any) {
    // Validate JSON-RPC request
    if (!this.isValidRequest(message)) {
      this.sendError(client.ws, message.id || null, RPC_ERRORS.INVALID_REQUEST);
      return;
    }

    const request = message as JsonRpcRequest;
    const method = this.methods.get(request.method);

    if (!method) {
      this.sendError(client.ws, request.id, RPC_ERRORS.METHOD_NOT_FOUND);
      return;
    }

    // Define read-only methods that don't require authentication
    const openAccessMethods = ['subscribe', 'unsubscribe', 'unsubscribeAll', 'getConversation', 'getAllConversations', 'createConversation'];
    
    // Check authentication for protected methods (write operations)
    if (request.method !== 'authenticate' && !openAccessMethods.includes(request.method) && !client.authenticated) {
      this.sendError(client.ws, request.id, RPC_ERRORS.UNAUTHORIZED);
      return;
    }

    try {
      const result = await method(client, request.params);
      this.sendResponse(client.ws, request.id, result);
    } catch (error: any) {
      console.error(`Error in method ${request.method}:`, error);
      this.sendError(client.ws, request.id, {
        code: RPC_ERRORS.INTERNAL_ERROR.code,
        message: error.message || RPC_ERRORS.INTERNAL_ERROR.message,
        data: error.data
      });
    }
  }

  private handleDisconnect(ws: ServerWebSocket) {
    const client = this.findClientByWebSocket(ws);
    if (client) {
      // Unsubscribe from all events
      client.subscriptions.forEach(unsubscribe => unsubscribe());
      this.clients.delete(client.id);
      this.wsToClientId.delete((ws as any).raw);
      console.log(`Client ${client.id} disconnected`);
    }
  }

  private findClientByWebSocket(ws: ServerWebSocket): ClientState | undefined {
    // Use Map with the underlying raw WebSocket to find client ID
    const clientId = this.wsToClientId.get((ws as any).raw);
    return clientId ? this.clients.get(clientId) : undefined;
  }

  // ============= JSON-RPC Helper Methods =============

  private isValidRequest(message: any): boolean {
    return (
      message &&
      message.jsonrpc === '2.0' &&
      typeof message.id !== 'undefined' &&
      typeof message.method === 'string'
    );
  }

  private sendResponse(ws: ServerWebSocket, id: string | number, result: any) {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id,
      result
    };
    ws.send(JSON.stringify(response));
  }

  private sendError(ws: ServerWebSocket, id: string | number | null, error: JsonRpcError) {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: id || 0,
      error
    };
    ws.send(JSON.stringify(response));
  }

  private sendNotification(ws: ServerWebSocket, method: string, params: any) {
    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method,
      params
    };
    ws.send(JSON.stringify(notification));
  }

  // ============= RPC Methods =============

  private async authenticate(client: ClientState, params: { token: string }): Promise<any> {
    if (!params?.token) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Token required' };
    }

    const auth = this.orchestrator.validateAgentToken(params.token);
    if (!auth) {
      throw RPC_ERRORS.INVALID_TOKEN;
    }

    client.authenticated = true;
    client.conversationId = auth.conversationId;
    client.agentId = auth.agentId;

    return {
      success: true,
      conversationId: auth.conversationId,
      agentId: auth.agentId
    };
  }

  private async subscribe(client: ClientState, params: {
    conversationId?: string;
    events?: string[];
    agents?: string[];
    options?: SubscriptionOptions;
  }): Promise<any> {
    const conversationId = params?.conversationId || client.conversationId;
    if (!conversationId) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Conversation ID required' };
    }

    const subscriptionId = uuidv4();
    
    // Build subscription options from direct params or options object
    const subscriptionOptions: SubscriptionOptions | undefined = params?.options || (
      (params?.events || params?.agents) ? {
        events: params.events as any,
        agents: params.agents
      } : undefined
    );
    
    const unsubscribe = this.orchestrator.subscribeToConversation(
      conversationId,
      (event: ConversationEvent) => {
        this.sendNotification(client.ws, 'event', {
          subscriptionId,
          event
        });
      },
      subscriptionOptions
    );

    client.subscriptions.set(subscriptionId, unsubscribe);

    return {
      subscriptionId,
      conversationId,
      options: subscriptionOptions
    };
  }

  private async unsubscribe(client: ClientState, params: { subscriptionId: string }): Promise<any> {
    if (!params?.subscriptionId) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Subscription ID required' };
    }

    const unsubscribe = client.subscriptions.get(params.subscriptionId);
    if (!unsubscribe) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Subscription not found' };
    }

    unsubscribe();
    client.subscriptions.delete(params.subscriptionId);

    return { success: true };
  }

  private async unsubscribeAll(client: ClientState): Promise<any> {
    client.subscriptions.forEach(unsubscribe => unsubscribe());
    client.subscriptions.clear();
    
    return { 
      success: true, 
      unsubscribed: client.subscriptions.size 
    };
  }

  private async startTurn(client: ClientState, params: Partial<StartTurnRequest>): Promise<any> {
    if (!client.conversationId || !client.agentId) {
      throw RPC_ERRORS.UNAUTHORIZED;
    }

    const request: StartTurnRequest = {
      conversationId: client.conversationId,
      agentId: client.agentId,
      metadata: params?.metadata
    };

    return this.orchestrator.startTurn(request);
  }

  private async addTrace(client: ClientState, params: {
    turnId: string;
    entry: Omit<TraceEntry, 'id' | 'timestamp' | 'agentId'>;
  }): Promise<any> {
    if (!client.conversationId || !client.agentId) {
      throw RPC_ERRORS.UNAUTHORIZED;
    }

    if (!params?.turnId || !params?.entry) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Turn ID and entry required' };
    }

    const request: AddTraceEntryRequest = {
      conversationId: client.conversationId,
      turnId: params.turnId,
      agentId: client.agentId,
      entry: params.entry
    };

    this.orchestrator.addTraceEntry(request);
    return { success: true };
  }

  private async completeTurn(client: ClientState, params: {
    turnId: string;
    content: string;
    isFinalTurn?: boolean;
    metadata?: Record<string, any>;
  }): Promise<any> {
    if (!client.conversationId || !client.agentId) {
      throw RPC_ERRORS.UNAUTHORIZED;
    }

    if (!params?.turnId || !params?.content) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Turn ID and content required' };
    }

    const request: CompleteTurnRequest = {
      conversationId: client.conversationId,
      turnId: params.turnId,
      agentId: client.agentId,
      content: params.content,
      isFinalTurn: params.isFinalTurn,
      metadata: params.metadata
    };

    const turn = this.orchestrator.completeTurn(request);
    return turn;
  }


  private async createUserQuery(client: ClientState, params: {
    question: string;
    context?: Record<string, any>;
    timeout?: number;
  }): Promise<any> {
    if (!client.conversationId || !client.agentId) {
      throw RPC_ERRORS.UNAUTHORIZED;
    }

    if (!params?.question) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Question required' };
    }

    const request: UserQueryRequest = {
      conversationId: client.conversationId,
      agentId: client.agentId,
      question: params.question,
      context: params.context,
      timeout: params.timeout
    };

    const queryId = this.orchestrator.createUserQuery(request);
    return queryId;
  }

  private async respondToUserQuery(client: ClientState, params: {
    queryId: string;
    response: string;
  }): Promise<any> {
    if (!params?.queryId || !params?.response) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Query ID and response required' };
    }

    this.orchestrator.respondToUserQuery(params.queryId, params.response);
    return { success: true };
  }

  private async getPendingUserQueries(client: ClientState, params: {
    conversationId?: string;
  }): Promise<any> {
    const conversationId = params?.conversationId || client.conversationId;
    if (!conversationId) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Conversation ID required' };
    }

    const queries = this.orchestrator.getPendingUserQueries(conversationId);
    return { queries, count: queries.length };
  }

  private async getAllPendingUserQueries(client: ClientState): Promise<any> {
    const queries = this.orchestrator.getAllPendingUserQueries();
    return { queries, count: queries.length };
  }

  private async getConversation(client: ClientState, params: {
    conversationId?: string;
    includeTurns?: boolean;
    includeTrace?: boolean;
    includeInProgress?: boolean;
  }): Promise<any> {
    const conversationId = params?.conversationId || client.conversationId;
    if (!conversationId) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Conversation ID required' };
    }

    const conversation = this.orchestrator.getConversation(
      conversationId,
      params?.includeTurns !== false,
      params?.includeTrace === true,
      params?.includeInProgress === true
    );

    if (!conversation) {
      throw RPC_ERRORS.CONVERSATION_NOT_FOUND;
    }

    return conversation;
  }

  private async getAllConversations(client: ClientState, params?: {
    limit?: number;
    offset?: number;
    includeTurns?: boolean;
    includeTrace?: boolean;
  }): Promise<any> {
    return this.orchestrator.getAllConversations(params);
  }

  private async createConversation(client: ClientState, params: CreateConversationRequest): Promise<any> {
    if (!params) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'CreateConversationRequest required' };
    }

    const response = await this.orchestrator.createConversation(params);
    return response;
  }

  private async startConversation(client: ClientState, params: { conversationId: string }): Promise<any> {
    if (!params?.conversationId) {
      throw { ...RPC_ERRORS.INVALID_PARAMS, data: 'Conversation ID required' };
    }

    await this.orchestrator.startConversation(params.conversationId);
    return { success: true, message: 'Conversation started successfully' };
  }

  // ============= Utility Methods =============

  broadcastToConversation(conversationId: string, notification: any) {
    this.clients.forEach(client => {
      if (client.conversationId === conversationId && client.authenticated) {
        this.sendNotification(client.ws, 'broadcast', notification);
      }
    });
  }

  getConnectedClients(): number {
    return this.clients.size;
  }

  getClientInfo(clientId: string): ClientState | undefined {
    return this.clients.get(clientId);
  }

  // Get the Hono app for integration
  getApp(): Hono {
    console.log('[WS Server] getApp() called, returning Hono app');
    return this.app;
  }

  // Get the websocket handler for Bun.serve
  getWebSocketHandler() {
    return this.websocket;
  }

  close() {
    this.clients.forEach(client => {
      client.subscriptions.forEach(unsubscribe => unsubscribe());
      client.ws.close();
    });
    this.clients.clear();
    this.wsToClientId.clear();
  }
}