// In-Process Agent for Testing

import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import {
  AgentConfig,
  AgentId,
  AgentInterface,
  ConversationEvent,
  ThoughtEntry, ToolCallEntry, ToolResultEntry,
  TurnCompletedEvent
} from '$lib/types.js';
import { v4 as uuidv4 } from 'uuid';

// ============= In-Process Base Agent =============

export abstract class InProcessBaseAgent implements AgentInterface {
  agentId: AgentId;
  config: AgentConfig;
  protected conversationId?: string;
  protected orchestrator: ConversationOrchestrator;

  constructor(config: AgentConfig, orchestrator: ConversationOrchestrator) {
    this.agentId = config.agentId;
    this.config = config;
    this.orchestrator = orchestrator;
  }

  async initialize(conversationId: string, authToken: string): Promise<void> {
    this.conversationId = conversationId;
    console.log(`Agent ${this.agentId.label} initialized for conversation ${conversationId}`);
  }

  async shutdown(): Promise<void> {
    console.log(`Agent ${this.agentId.label} shutting down`);
  }

  async onConversationEvent(event: ConversationEvent): Promise<void> {
    switch (event.type) {
      case 'turn_completed':
        await this.onTurnCompleted(event as TurnCompletedEvent);
        break;
      case 'conversation_ended':
        await this.shutdown();
        break;
    }
  }

  abstract onTurnCompleted(event: TurnCompletedEvent): Promise<void>;

  // ============= Direct Orchestrator Methods =============

  async startTurn(metadata?: Record<string, any>): Promise<string> {
    if (!this.conversationId) {
      throw new Error('Agent not initialized');
    }

    const response = await this.orchestrator.startTurn({
      conversationId: this.conversationId,
      agentId: this.agentId.id,
      metadata
    });

    return response.turnId;
  }

  async addThought(turnId: string, thought: string): Promise<void> {
    if (!this.conversationId) {
      throw new Error('Agent not initialized');
    }

    await this.orchestrator.addTraceEntry({
      conversationId: this.conversationId,
      turnId,
      agentId: this.agentId.id,
      entry: {
        type: 'thought',
        content: thought
      }
    });
  }

  async addToolCall(turnId: string, toolName: string, parameters: any): Promise<string> {
    if (!this.conversationId) {
      throw new Error('Agent not initialized');
    }

    const toolCallId = uuidv4();
    await this.orchestrator.addTraceEntry({
      conversationId: this.conversationId,
      turnId,
      agentId: this.agentId.id,
      entry: {
        type: 'tool_call',
        toolName,
        parameters,
        toolCallId
      }
    });

    return toolCallId;
  }

  async addToolResult(turnId: string, toolCallId: string, result: any, error?: string): Promise<void> {
    if (!this.conversationId) {
      throw new Error('Agent not initialized');
    }

    await this.orchestrator.addTraceEntry({
      conversationId: this.conversationId,
      turnId,
      agentId: this.agentId.id,
      entry: {
        type: 'tool_result',
        toolCallId,
        result,
        error
      }
    });
  }

  async completeTurn(turnId: string, content: string): Promise<void> {
    if (!this.conversationId) {
      throw new Error('Agent not initialized');
    }

    await this.orchestrator.completeTurn({
      conversationId: this.conversationId,
      turnId,
      agentId: this.agentId.id,
      content
    });
  }

  async queryUser(question: string, context?: Record<string, any>): Promise<string> {
    if (!this.conversationId) {
      throw new Error('Agent not initialized');
    }

    const queryId = await this.orchestrator.createUserQuery({
      conversationId: this.conversationId,
      agentId: this.agentId.id,
      question,
      context
    });

    // Poll for response
    const startTime = Date.now();
    const timeout = 300000; // 5 minutes

    while (Date.now() - startTime < timeout) {
      const status = await this.orchestrator.getUserQueryStatus(queryId);
      if (status.status === 'answered') {
        return status.response!;
      }

      // Wait before polling again
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    throw new Error('User query timeout');
  }

  // ============= Helper Methods =============

  protected createThought(content: string): ThoughtEntry {
    return {
      id: uuidv4(),
      agentId: this.agentId.id,
      timestamp: new Date(),
      type: 'thought',
      content
    };
  }

  protected createToolCall(toolName: string, parameters: Record<string, any>): ToolCallEntry {
    return {
      id: uuidv4(),
      agentId: this.agentId.id,
      timestamp: new Date(),
      type: 'tool_call',
      toolName,
      parameters,
      toolCallId: uuidv4()
    };
  }

  protected createToolResult(toolCallId: string, result: any, error?: string): ToolResultEntry {
    return {
      id: uuidv4(),
      agentId: this.agentId.id,
      timestamp: new Date(),
      type: 'tool_result',
      toolCallId,
      result,
      error
    };
  }
}

// ============= In-Process Static Replay Agent =============

export class InProcessStaticReplayAgent extends InProcessBaseAgent {
  private scriptIndex = 0;

  async onTurnCompleted(event: TurnCompletedEvent): Promise<void> {
    // Skip if it's our own turn
    if (event.data.turn.agentId === this.agentId.id) {
      return;
    }

    const config = this.config as any; // StaticReplayConfig

    // Check if any script entry matches
    for (let i = this.scriptIndex; i < config.script.length; i++) {
      const entry = config.script[i];

      // Check trigger if specified
      if (entry.trigger) {
        const regex = new RegExp(entry.trigger);
        if (!regex.test(event.data.turn.content)) {
          continue;
        }
      }

      // Start a new turn
      const turnId = await this.startTurn();

      // Add thoughts if specified
      if (entry.thoughts) {
        for (const thought of entry.thoughts) {
          await this.addThought(turnId, thought);
        }
      }

      // Wait if delay specified
      if (entry.delay) {
        await new Promise(resolve => setTimeout(resolve, entry.delay));
      }

      // Complete the turn with the response
      await this.completeTurn(turnId, entry.response);
      this.scriptIndex = i + 1;
      break;
    }
  }
}

// ============= Factory Function =============

export function createInProcessAgent(config: AgentConfig, orchestrator: ConversationOrchestrator): AgentInterface {
  switch (config.strategyType) {
    case 'static_replay':
      return new InProcessStaticReplayAgent(config, orchestrator);
    default:
      throw new Error(`In-process agent not implemented for strategy type: ${config.strategyType}`);
  }
}