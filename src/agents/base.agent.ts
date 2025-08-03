// Transport-Agnostic Base Agent Class

import type { OrchestratorClient } from '$client/index.js';
import {
  AgentConfig,
  AgentId,
  AgentInterface,
  ConversationEvent,
  ConversationTurn,
  ThoughtEntry, ToolCallEntry, ToolResultEntry,
  TurnCompletedEvent, TurnStartedEvent, TraceAddedEvent,
  UserQueryAnsweredEvent, RehydratedEvent,
  TraceEntry, Attachment
} from '$lib/types.js';
import { v4 as uuidv4 } from 'uuid';

export abstract class BaseAgent implements AgentInterface {
  agentId: AgentId;
  config: AgentConfig;
  protected client: OrchestratorClient;
  protected conversationId?: string;
  protected subscriptionId?: string;
  protected isReady: boolean = false;
  protected conversationEnded = false;
  
  // Private state maps for stateful design
  private turns: Map<string, ConversationTurn> = new Map();
  private turnOrder: string[] = [];
  private tracesByTurnId: Map<string, TraceEntry[]> = new Map();
  private attachmentsByTurnId: Map<string, Attachment[]> = new Map();
  private pendingUserQueries: Map<string, { resolve: Function, reject: Function }> = new Map();
  
  // Current turn tracking
  private currentTurnId: string | null = null;
  private lastProcessedTurnId: string | null = null;

  constructor(config: AgentConfig, client: OrchestratorClient) {
    this.agentId = config.agentId;
    this.config = config;
    this.client = client;

    this.client.on('event', this._handleEvent.bind(this));
  }

  async initialize(conversationId: string, authToken: string): Promise<void> {
    console.log(`Agent ${this.agentId.label} starting initialization...`);
    this.conversationId = conversationId;
    
    await this.client.connect(authToken);
    await this.client.authenticate(authToken);
    
    this.subscriptionId = await this.client.subscribe(conversationId);
    this.isReady = true;
    console.log(`Agent ${this.agentId.label} initialized for conversation ${conversationId} - READY FLAG SET`);
  }

  async shutdown(): Promise<void> {
    this.isReady = false;
    this.conversationEnded = true;
    if (this.subscriptionId) {
      await this.client.unsubscribe(this.subscriptionId);
    }

    this.client.disconnect();
    console.log(`Agent ${this.agentId.label} shutting down`);
  }

  private _handleEvent(event: ConversationEvent, subscriptionId: string) {
    if (subscriptionId === this.subscriptionId) {
      this.onConversationEvent(event);
    }
  }

  async onConversationEvent(event: ConversationEvent): Promise<void> {
    // Don't process events until agent is fully ready
    if (!this.isReady) {
      console.log(`Agent ${this.agentId.label} ignoring ${event.type} - not ready yet`);
      return;
    }
    
    switch (event.type) {
      case 'turn_started':
        await this.onTurnStarted(event as TurnStartedEvent);
        break;
      case 'turn_completed':
        await this.onTurnCompletedInternal(event as TurnCompletedEvent);
        break;
      case 'trace_added':
        await this.onTraceAdded(event as TraceAddedEvent);
        break;
      case 'user_query_answered':
        await this.onUserQueryAnswered(event as UserQueryAnsweredEvent);
        break;
      case 'rehydrated':
        await this.onRehydrated(event as RehydratedEvent);
        break;
      case 'conversation_ended':
        this.isReady = false;
        this.conversationEnded = true;
        break;
    }
  }

  // Abstract method for subclasses to implement their core logic
  abstract onTurnCompleted(event: TurnCompletedEvent): Promise<void>;

  // Abstract method for initiating a conversation (no previous turn)
  abstract initializeConversation(instructions?: string): Promise<void>;

  // Abstract method for processing and replying to a turn
  abstract processAndReply(previousTurn: ConversationTurn): Promise<void>;
  
  // ============= Internal Event Handlers =============
  
  private async onTurnStarted(event: TurnStartedEvent): Promise<void> {
    const turn = event.data.turn;
    this.turns.set(turn.id, turn);
    this.turnOrder.push(turn.id);
  }
  
  private async onTurnCompletedInternal(event: TurnCompletedEvent): Promise<void> {
    const turn = event.data.turn;
    this.turns.set(turn.id, turn);
    
    // Store traces if present
    if (turn.trace && turn.trace.length > 0) {
      this.tracesByTurnId.set(turn.id, turn.trace);
    }
    
    // Process attachments if present
    if (turn.attachments && turn.attachments.length > 0) {
      const attachments: Attachment[] = [];
      for (const attachmentId of turn.attachments) {
        const attachment = await this.client.getAttachment(attachmentId);
        if (attachment) {
          attachments.push(attachment);
        }
      }
      this.attachmentsByTurnId.set(turn.id, attachments);
    }
    
    // Call the abstract method that subclasses implement
    await this.onTurnCompleted(event);
    
    // Check if we should process this turn
    if (turn.agentId !== this.agentId.id && !turn.isFinalTurn) {
      await this.maybeProcessNextOpportunity();
    }
  }
  
  private async onTraceAdded(event: TraceAddedEvent): Promise<void> {
    const turnId = event.data.turn.id;
    const trace = event.data.trace;
    
    const existingTraces = this.tracesByTurnId.get(turnId) || [];
    existingTraces.push(trace);
    this.tracesByTurnId.set(turnId, existingTraces);
  }
  
  private async onUserQueryAnswered(event: UserQueryAnsweredEvent): Promise<void> {
    const queryId = event.data.queryId;
    const pending = this.pendingUserQueries.get(queryId);
    if (pending) {
      this.pendingUserQueries.delete(queryId);
      pending.resolve(event.data.response);
    }
  }
  
  private async onRehydrated(event: RehydratedEvent): Promise<void> {
    console.log(`Agent ${this.agentId.label} received rehydration event`);
    
    // Clear and rebuild all state from snapshot
    this.turns.clear();
    this.turnOrder = [];
    this.tracesByTurnId.clear();
    this.attachmentsByTurnId.clear();
    
    const conversation = event.data.conversation;
    
    // Rebuild turns and traces
    for (const turn of conversation.turns || []) {
      this.turns.set(turn.id, turn);
      this.turnOrder.push(turn.id);
      
      if (turn.trace && turn.trace.length > 0) {
        this.tracesByTurnId.set(turn.id, turn.trace);
      }
    }
    
    // Rebuild attachments from conversation level
    if (conversation.attachments) {
      for (const attachment of conversation.attachments) {
        const turnAttachments = this.attachmentsByTurnId.get(attachment.turnId) || [];
        turnAttachments.push(attachment);
        this.attachmentsByTurnId.set(attachment.turnId, turnAttachments);
      }
    }
    
    // Check if we had an in-progress turn
    const inProgressTurn = conversation.turns.find(
      t => t.status === 'in_progress' && t.agentId === this.agentId.id
    );
    
    if (inProgressTurn) {
      console.log(`Agent ${this.agentId.label} aborting in-progress turn ${inProgressTurn.id}`);
      await this._abortCurrentTurn(inProgressTurn.id);
    }
    
    // Clear pending queries as they are now stale
    for (const [queryId, { reject }] of this.pendingUserQueries) {
      reject(new Error('Query cancelled due to rehydration'));
    }
    this.pendingUserQueries.clear();
    
    // Check if we should take a turn
    await this.maybeProcessNextOpportunity();
  }
  
  private async _abortCurrentTurn(turnId: string): Promise<void> {
    try {
      const abortMessage = this.getAbortMessage();
      await this.client.completeTurn(turnId, abortMessage);
    } catch (error) {
      console.error(`Failed to abort turn ${turnId}:`, error);
    }
  }
  
  protected getAbortMessage(): string {
    return "I encountered a brief connection issue and had to abort my previous action. I will now re-evaluate the situation.";
  }
  
  private async maybeProcessNextOpportunity(): Promise<void> {
    if (!this.isReady || this.currentTurnId || this.conversationEnded) return;
    
    // Check if we should initiate
    if (this.turnOrder.length === 0 && this.isInitiator()) {
      await this.initializeConversation();
      return;
    }
    
    // Check last turn
    const lastTurnId = this.turnOrder[this.turnOrder.length - 1];
    const lastTurn = this.turns.get(lastTurnId);
    
    if (lastTurn && lastTurn.agentId !== this.agentId.id && lastTurn.id !== this.lastProcessedTurnId) {
      this.lastProcessedTurnId = lastTurn.id;
      await this.processAndReply(lastTurn);
    }
  }
  
  private isInitiator(): boolean {
    // Check if this agent should initiate based on config
    return !!(this.config as any).messageToUseWhenInitiatingConversation;
  }

  // ============= Simplified Public API (No Turn IDs!) =============
  
  protected async startTurn(metadata?: Record<string, any>): Promise<void> {
    if (this.currentTurnId) throw new Error('Turn already in progress');
    this.currentTurnId = await this.client.startTurn(metadata);
  }
  
  protected async completeTurn(content: string, isFinalTurn?: boolean, attachments?: string[]): Promise<void> {
    if (!this.currentTurnId) throw new Error('No turn in progress');
    await this.client.completeTurn(this.currentTurnId, content, isFinalTurn, undefined, attachments);
    this.currentTurnId = null;
  }
  
  protected async addThought(thought: string): Promise<void> {
    if (!this.currentTurnId) throw new Error('No turn in progress');
    const entry = await this.client.addTrace(this.currentTurnId, { type: 'thought', content: thought });
    // Update local state
    const existingTraces = this.tracesByTurnId.get(this.currentTurnId) || [];
    existingTraces.push({
      id: uuidv4(),
      agentId: this.agentId.id,
      timestamp: new Date(),
      type: 'thought',
      content: thought
    } as ThoughtEntry);
    this.tracesByTurnId.set(this.currentTurnId, existingTraces);
  }
  
  protected async addToolCall(toolName: string, parameters: any): Promise<string> {
    if (!this.currentTurnId) throw new Error('No turn in progress');
    const toolCallId = uuidv4();
    await this.client.addTrace(this.currentTurnId, { 
      type: 'tool_call', 
      toolName, 
      parameters, 
      toolCallId 
    });
    // Update local state
    const existingTraces = this.tracesByTurnId.get(this.currentTurnId) || [];
    existingTraces.push({
      id: uuidv4(),
      agentId: this.agentId.id,
      timestamp: new Date(),
      type: 'tool_call',
      toolName,
      parameters,
      toolCallId
    } as ToolCallEntry);
    this.tracesByTurnId.set(this.currentTurnId, existingTraces);
    return toolCallId;
  }
  
  protected async addToolResult(toolCallId: string, result: any, error?: string): Promise<void> {
    if (!this.currentTurnId) throw new Error('No turn in progress');
    await this.client.addTrace(this.currentTurnId, { 
      type: 'tool_result', 
      toolCallId, 
      result, 
      error 
    });
    // Update local state
    const existingTraces = this.tracesByTurnId.get(this.currentTurnId) || [];
    existingTraces.push({
      id: uuidv4(),
      agentId: this.agentId.id,
      timestamp: new Date(),
      type: 'tool_result',
      toolCallId,
      result,
      error
    } as ToolResultEntry);
    this.tracesByTurnId.set(this.currentTurnId, existingTraces);
  }
  
  async queryUser(question: string, context?: Record<string, any>): Promise<string> {
    const queryId = await this.client.createUserQuery(question, context);
    
    return new Promise((resolve, reject) => {
      // Store in pending queries map
      this.pendingUserQueries.set(queryId, { resolve, reject });
      
      // Set timeout
      setTimeout(() => {
        if (this.pendingUserQueries.has(queryId)) {
          this.pendingUserQueries.delete(queryId);
          reject(new Error('User query timeout'));
        }
      }, 300000); // 5 minutes
    });
  }
  
  // ============= State Access Methods =============
  
  protected getTurns(): ConversationTurn[] {
    return this.turnOrder.map(id => this.turns.get(id)!).filter(Boolean);
  }
  
  protected getLastTurn(): ConversationTurn | null {
    const lastId = this.turnOrder[this.turnOrder.length - 1];
    return lastId ? this.turns.get(lastId) || null : null;
  }
  
  protected getTraceForTurn(turnId: string): TraceEntry[] {
    return this.tracesByTurnId.get(turnId) || [];
  }
  
  protected getAttachmentsForTurn(turnId: string): Attachment[] {
    return this.attachmentsByTurnId.get(turnId) || [];
  }
  
  protected getCurrentTurnTrace(): TraceEntry[] {
    if (!this.currentTurnId) return [];
    return this.getTraceForTurn(this.currentTurnId);
  }
  
  protected getCurrentTurnId(): string | null {
    return this.currentTurnId;
  }

}