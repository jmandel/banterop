// Conversation and Trace Types
// This file contains all conversation-related type definitions

// ============= Base Types =============

export interface ConversationId {
  id: string;
  name?: string;
  createdAt: Date;
}

// ============= Trace Types =============

export type TraceEntryType = 'thought' | 'tool_call' | 'tool_result' | 'user_query' | 'user_response';

export interface BaseTraceEntry {
  id: string;
  agentId: string;
  timestamp: Date;
  type: TraceEntryType;
}

export interface ThoughtEntry extends BaseTraceEntry {
  type: 'thought';
  content: string;
}

export interface ToolCallEntry extends BaseTraceEntry {
  type: 'tool_call';
  toolName: string;
  parameters: Record<string, any>;
  toolCallId: string;
}

export interface ToolResultEntry extends BaseTraceEntry {
  type: 'tool_result';
  toolCallId: string;
  result: any;
  error?: string;
}

export interface UserQueryEntry extends BaseTraceEntry {
  type: 'user_query';
  queryId: string;
  question: string;
  context?: Record<string, any>;
}

export interface UserResponseEntry extends BaseTraceEntry {
  type: 'user_response';
  queryId: string;
  response: string;
}

export type TraceEntry = ThoughtEntry | ToolCallEntry | ToolResultEntry | UserQueryEntry | UserResponseEntry;

// ============= Conversation Types =============

export interface ConversationTurn {
  id: string;
  conversationId: string;
  agentId: string;
  timestamp: Date;
  content: string;
  metadata?: Record<string, any>;
  status: 'in_progress' | 'completed' | 'cancelled';
  startedAt: Date;
  completedAt?: Date;
  trace?: TraceEntry[]; // Embedded trace entries when requested
  isFinalTurn?: boolean; // Indicates if this is the final turn in the conversation
  attachments?: string[]; // Array of attachment IDs
}

// TurnShell - ConversationTurn without trace array for efficient event payloads
export type TurnShell = Omit<ConversationTurn, 'trace'>;

export interface InProgressTurn {
  id: string;
  conversationId: string;
  agentId: string;
  startedAt: Date;
  metadata?: Record<string, any>;
}

export interface Conversation {
  id: string;
  name?: string;
  createdAt: Date;
  agents: any[]; // AgentId[] - avoiding circular dependency
  turns: ConversationTurn[];
  status: 'created' | 'active' | 'completed' | 'failed';
  metadata?: Record<string, any>;
  inProgressTurns?: Record<string, InProgressTurn>; // agentId -> in-progress turn
  attachments?: Attachment[]; // Added for rehydration support
}

// ============= Event Types =============

export interface ConversationEvent {
  type: 'turn_started' | 'trace_added' | 'turn_completed' | 'turn_cancelled' |
        'conversation_created' | 'conversation_ended' | 'conversation_ready' | 'user_query_created' | 
        'user_query_answered' | 'agent_thinking' | 'tool_executing' | 'rehydrated';
  conversationId: string;
  timestamp: Date;
  data: any;
}

export interface TurnStartedEvent extends ConversationEvent {
  type: 'turn_started';
  data: {
    turn: ConversationTurn;  // Full turn object (initial state)
  };
}

export interface TraceAddedEvent extends ConversationEvent {
  type: 'trace_added';
  data: {
    turn: TurnShell;     // Turn context without trace array
    trace: TraceEntry;   // The specific new trace entry
  };
}

export interface TurnCompletedEvent extends ConversationEvent {
  type: 'turn_completed';
  data: {
    turn: ConversationTurn;  // Full turn object (complete state)
  };
}


export interface AgentThinkingEvent extends ConversationEvent {
  type: 'agent_thinking';
  data: {
    agentId: string;
    thought: string;
  };
}

export interface ToolExecutingEvent extends ConversationEvent {
  type: 'tool_executing';
  data: {
    agentId: string;
    toolName: string;
    parameters: any;
  };
}

export interface UserQueryCreatedEvent extends ConversationEvent {
  type: 'user_query_created';
  data: {
    query: {
      queryId: string;
      agentId: string;
      question: string;
      context: Record<string, any>;
      createdAt: Date;
      timeout: number;
    };
  };
}

export interface UserQueryAnsweredEvent extends ConversationEvent {
  type: 'user_query_answered';
  data: {
    queryId: string;
    response: string;
    context: Record<string, any>;
  };
}

export interface RehydratedEvent extends ConversationEvent {
  type: 'rehydrated';
  data: {
    conversation: Conversation;
  };
}

// ============= Backend Orchestrator Types =============

/**
 * Backend conversation state for orchestrator management
 * Contains the active conversation data and agent configurations
 */
export interface OrchestratorConversationState {
  conversation: Conversation;
  agentConfigs: Map<string, any>; // AgentConfig - avoiding circular dependency
  agentTokens: Record<string, string>;
  agents?: Map<string, any>; // AgentInterface - avoiding circular dependency
}

// ============= Attachment Types =============

export interface Attachment {
  id: string;                 // att_<uuid>
  conversationId: string;
  turnId: string;
  docId?: string;             // Original document ID (like a filename)
  name: string;
  contentType: string;        // e.g., 'text/markdown'
  content: string;            // text body
  summary?: string;           // Optional summary of the document
  createdByAgentId: string;
  createdAt: Date;
}

export interface AttachmentPayload {
  docId?: string;             // The original, logical ID from the tool result
  name: string;
  contentType: string;
  content: string;
  summary?: string;
}

// ============= Frontend Monitor Types =============

/**
 * Frontend-specific conversation state for real-time monitoring
 * Used by the executor app for WebSocket-based conversation viewing
 */
export interface ConversationState {
  turns: Turn[];
  traces: Record<string, ExecutionTrace>;
  version: number;
}

/**
 * Frontend turn representation for conversation display
 * Simplified from ConversationTurn for UI consumption
 */
export interface Turn {
  id: string;
  role: string;
  kind: string;
  timestamp: number;
  content: Array<{
    type: 'text' | 'data';
    text?: string;
    data?: any;
  }>;
  traceId?: string;
}

/**
 * Execution trace for debugging and inspection
 * Contains all the steps an agent took during a turn
 */
export interface ExecutionTrace {
  turnId: string;
  steps: TraceStep[];
}

/**
 * Individual step within an execution trace
 * Represents a single action or thought in the agent's process
 */
export interface TraceStep {
  id: string;
  type: 'thought' | 'tool_call' | 'tool_result' | 'synthesis';
  label: string;
  detail?: string;
  data?: any;
  timestamp: number;
}