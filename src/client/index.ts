// Client Interface for Agent Communication Platform
// Provides transport-agnostic client interface for orchestrator interactions

import { EventEmitter } from 'events';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { InProcessOrchestratorClient } from './impl/in-process.client.js';
import { WebSocketJsonRpcClient } from './impl/websocket.client.js';
import {
  ConversationEvent, SubscriptionOptions, TraceEntry, TraceEntryInput,
  ConversationTurn, CreateConversationRequest, CreateConversationResponse,
  Conversation, Attachment, AttachmentPayload
} from '$lib/types.js';

// ============= Abstract Client Interface =============

export interface OrchestratorClient extends EventEmitter {
  // Connection management
  connect(authToken?: string): Promise<void>;
  disconnect(): void;
  
  // Authentication
  authenticate(token: string): Promise<any>;
  
  // Conversation Lifecycle Management
  createConversation(request: CreateConversationRequest): Promise<CreateConversationResponse>;
  startConversation(conversationId: string): Promise<void>;
  
  // Subscription management
  subscribe(conversationId: string, options?: SubscriptionOptions): Promise<string>;
  unsubscribe(subscriptionId: string): Promise<void>;
  unsubscribeAll(): Promise<void>;
  
  // Turn management
  startTurn(metadata?: Record<string, any>): Promise<string>;
  addTrace(turnId: string, entry: TraceEntryInput): Promise<void>;
  completeTurn(turnId: string, content: string, isFinalTurn?: boolean, metadata?: Record<string, any>, attachments?: AttachmentPayload[]): Promise<ConversationTurn>;
  
  // Attachment management
  getAttachment(attachmentId: string): Promise<Attachment | null>;
  getAttachmentByDocId(conversationId: string, docId: string): Promise<Attachment | null>;
  
  
  // User interaction
  createUserQuery(question: string, context?: Record<string, any>, timeout?: number): Promise<string>;
  respondToUserQuery(queryId: string, response: string): Promise<void>;
  
  // Conversation access
  getConversation(conversationId?: string, options?: {
    includeTurns?: boolean;
    includeTrace?: boolean;
    includeInProgress?: boolean;
    includeAttachments?: boolean;
  }): Promise<Conversation>;
  
  getAllConversations(options?: { 
    limit?: number; 
    offset?: number; 
    includeTurns?: boolean; 
    includeTrace?: boolean;
    includeAttachments?: boolean;
  }): Promise<{ conversations: any[]; total: number; limit: number; offset: number }>;
  
  // Conversation management
  endConversation(conversationId?: string): Promise<void>;
}

// ============= Client Factory Functions =============

/**
 * Creates an in-process client for server-side testing or embedded use.
 * Requires a direct instance of the ConversationOrchestrator.
 */
export function createInProcessClient(orchestrator: ConversationOrchestrator): OrchestratorClient {
  return new InProcessOrchestratorClient(orchestrator);
}

/**
 * Creates a WebSocket client for network-based communication.
 * Requires a WebSocket implementation (e.g., global `WebSocket` in browser, or from 'ws' package in Node).
 */
export function createWebSocketClient(url: string): OrchestratorClient {
  return new WebSocketJsonRpcClient(url);
}

/**
 * Legacy factory function for backward compatibility.
 * @deprecated Use createInProcessClient or createWebSocketClient instead.
 */
export function createClient(
  mode: 'websocket' | 'in-process',
  orchestratorOrUrl?: ConversationOrchestrator | string,
): OrchestratorClient {
  switch (mode) {
    case 'websocket':
      const url = (typeof orchestratorOrUrl === 'string') 
        ? orchestratorOrUrl 
        : 'ws://localhost:3001';
      
      return new WebSocketJsonRpcClient(url);
      
    case 'in-process':
      if (!orchestratorOrUrl || typeof orchestratorOrUrl === 'string') {
        throw new Error('In-process mode requires ConversationOrchestrator instance');
      }
      return new InProcessOrchestratorClient(orchestratorOrUrl);
      
    default:
      throw new Error(`Unknown client mode: ${mode}`);
  }
}

// Re-export client implementations for direct use if needed
export { InProcessOrchestratorClient } from './impl/in-process.client.js';
export { WebSocketJsonRpcClient } from './impl/websocket.client.js';
