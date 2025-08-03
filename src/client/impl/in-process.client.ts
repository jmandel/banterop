// In-Process Client Implementation

import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import {
  ConversationEvent, SubscriptionOptions, TraceEntry,
  ConversationTurn, StartTurnRequest, AddTraceEntryRequest,
  CompleteTurnRequest, UserQueryRequest, CreateConversationRequest,
  CreateConversationResponse, Attachment
} from '$lib/types.js';
import type { OrchestratorClient } from '../index.js';

export class InProcessOrchestratorClient extends EventEmitter implements OrchestratorClient {
  private orchestrator: ConversationOrchestrator;
  private conversationId?: string;
  private agentId?: string;
  private subscriptions: Map<string, () => void> = new Map();
  private connected = false;
  private authenticated = false;

  constructor(orchestrator: ConversationOrchestrator) {
    super();
    this.orchestrator = orchestrator;
  }

  async connect(authToken?: string): Promise<void> {
    this.connected = true;
    
    if (authToken) {
      await this.authenticate(authToken);
    }
  }

  disconnect(): void {
    // Unsubscribe from all subscriptions
    this.subscriptions.forEach(unsubscribe => unsubscribe());
    this.subscriptions.clear();
    
    this.connected = false;
    this.authenticated = false;
    this.conversationId = undefined;
    this.agentId = undefined;
  }

  async authenticate(token: string): Promise<any> {
    if (!this.connected) {
      throw new Error('Client not connected');
    }

    const auth = this.orchestrator.validateAgentToken(token);
    if (!auth) {
      throw new Error('Invalid token');
    }

    this.conversationId = auth.conversationId;
    this.agentId = auth.agentId;
    this.authenticated = true;

    return { success: true, conversationId: auth.conversationId, agentId: auth.agentId };
  }

  async createConversation(request: CreateConversationRequest): Promise<CreateConversationResponse> {
    if (!this.connected) {
      throw new Error('Client not connected');
    }

    return await this.orchestrator.createConversation(request);
  }

  async startConversation(conversationId: string): Promise<void> {
    if (!this.connected) {
      throw new Error('Client not connected');
    }

    await this.orchestrator.startConversation(conversationId);
  }

  async subscribe(conversationId: string, options?: SubscriptionOptions): Promise<string> {
    if (!this.connected) {
      throw new Error('Client not connected');
    }

    const subscriptionId = uuidv4();
    
    // Subscribe to orchestrator events
    const unsubscribe = this.orchestrator.subscribeToConversation(
      conversationId,
      (event: ConversationEvent) => {
        this.emit('event', event, subscriptionId);
      },
      options
    );

    // Store the unsubscribe function
    this.subscriptions.set(subscriptionId, unsubscribe);

    return subscriptionId;
  }

  async unsubscribe(subscriptionId: string): Promise<void> {
    const unsubscribe = this.subscriptions.get(subscriptionId);
    if (unsubscribe) {
      unsubscribe();
      this.subscriptions.delete(subscriptionId);
    }
  }

  async unsubscribeAll(): Promise<void> {
    this.subscriptions.forEach(unsubscribe => unsubscribe());
    this.subscriptions.clear();
  }

  async startTurn(metadata?: Record<string, any>): Promise<string> {
    console.log(`Client startTurn called - authenticated: ${this.authenticated}, conversationId: ${this.conversationId}, agentId: ${this.agentId}, connected: ${this.connected}`);
    if (!this.authenticated || !this.conversationId || !this.agentId) {
      console.log(`Client auth check failed - authenticated: ${this.authenticated}, conversationId: ${this.conversationId}, agentId: ${this.agentId}`);
      throw new Error('Client not authenticated');
    }

    const request: StartTurnRequest = {
      conversationId: this.conversationId,
      agentId: this.agentId,
      metadata
    };

    const response = this.orchestrator.startTurn(request);
    return response.turnId;
  }

  async addTrace(turnId: string, entry: Omit<TraceEntry, 'id' | 'timestamp' | 'agentId'>): Promise<void> {
    if (!this.authenticated || !this.conversationId || !this.agentId) {
      throw new Error('Client not authenticated');
    }

    const request: AddTraceEntryRequest = {
      conversationId: this.conversationId,
      turnId,
      agentId: this.agentId,
      entry
    };

    this.orchestrator.addTraceEntry(request);
  }

  async completeTurn(turnId: string, content: string, isFinalTurn?: boolean, metadata?: Record<string, any>, attachments?: string[]): Promise<ConversationTurn> {
    if (!this.authenticated || !this.conversationId || !this.agentId) {
      throw new Error('Client not authenticated');
    }

    const request: CompleteTurnRequest = {
      conversationId: this.conversationId,
      turnId,
      agentId: this.agentId,
      content,
      isFinalTurn,
      metadata,
      attachments
    };

    return this.orchestrator.completeTurn(request);
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
    if (!this.authenticated) {
      throw new Error('Client not authenticated');
    }

    return this.orchestrator.registerAttachment(params);
  }

  async getAttachment(attachmentId: string): Promise<Attachment | null> {
    return this.orchestrator.getDbInstance().getAttachment(attachmentId);
  }

  async getAttachmentByDocId(conversationId: string, docId: string): Promise<Attachment | null> {
    const attachments = this.orchestrator.getDbInstance().listAttachments(conversationId);
    return attachments.find(att => att.docId === docId) || null;
  }


  async createUserQuery(question: string, context?: Record<string, any>, timeout?: number): Promise<string> {
    if (!this.authenticated || !this.conversationId || !this.agentId) {
      throw new Error('Client not authenticated');
    }

    const request: UserQueryRequest = {
      conversationId: this.conversationId,
      agentId: this.agentId,
      question,
      context,
      timeout
    };

    return this.orchestrator.createUserQuery(request);
  }

  async respondToUserQuery(queryId: string, response: string): Promise<void> {
    this.orchestrator.respondToUserQuery(queryId, response);
  }

  async getConversation(conversationId?: string, options?: {
    includeTurns?: boolean;
    includeTrace?: boolean;
    includeInProgress?: boolean;
    includeAttachments?: boolean;
  }): Promise<any> {
    const targetConversationId = conversationId || this.conversationId;
    if (!targetConversationId) {
      throw new Error('No conversation ID available');
    }

    return this.orchestrator.getConversation(
      targetConversationId,
      options?.includeTurns ?? true,
      options?.includeTrace ?? false,
      options?.includeInProgress ?? false
    );
  }

  async getAllConversations(options?: { 
    limit?: number; 
    offset?: number; 
    includeTurns?: boolean; 
    includeTrace?: boolean;
    includeAttachments?: boolean;
  }): Promise<{ conversations: any[]; total: number; limit: number; offset: number }> {
    return this.orchestrator.getAllConversations(options);
  }

  async endConversation(conversationId?: string): Promise<void> {
    const targetConversationId = conversationId || this.conversationId;
    if (!targetConversationId) {
      throw new Error('No conversation ID available');
    }

    this.orchestrator.endConversation(targetConversationId);
  }
}