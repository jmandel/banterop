// Agent Strategy Types and Configuration
// This file contains all agent-related type definitions

// ============= Base Agent Types =============

export interface AgentId {
  id: string;
  label: string; // Human-readable label for @mentions
  role: string;  // e.g., "assistant", "user", "reviewer", "moderator"
}

export type AgentStrategyType = 
  | 'static_replay' 
  | 'rule_based' 
  | 'external_proxy'
  | 'hybrid'
  | 'scenario_driven'
  | 'sequential_script';

export interface BaseAgentConfig {
  agentId: AgentId;
  strategyType: AgentStrategyType;
}

// ============= Strategy-Specific Configurations =============

export interface StaticReplayConfig extends BaseAgentConfig {
  strategyType: 'static_replay';
  script: Array<{
    trigger?: string; // Optional regex to match incoming messages
    delay?: number;   // ms to wait before responding
    response: string;
    thoughts?: string[];
  }>;
}

export interface RuleBasedConfig extends BaseAgentConfig {
  strategyType: 'rule_based';
  rules: Array<{
    condition: string; // JS expression evaluated in sandbox
    actions: Array<{
      type: 'respond' | 'think' | 'call_tool';
      payload: any;
    }>;
  }>;
}

export interface ExternalProxyConfig extends BaseAgentConfig {
  strategyType: 'external_proxy';
  endpoint: string;
  headers?: Record<string, string>;
  timeout?: number;
}

export interface HybridConfig extends BaseAgentConfig {
  strategyType: 'hybrid';
  strategies: AgentConfig[]; // Can combine multiple strategies
  selector: string; // JS expression to choose strategy
}

export interface ScenarioDrivenAgentConfig extends BaseAgentConfig {
  strategyType: 'scenario_driven';
  scenarioId: string;
  scenarioVersionId?: string; // Optional: to pin a specific version
  role: 'PatientAgent' | 'SupplierAgent'; // The role within the scenario
  // Flexible parameters to allow for variations within a single scenario
  parameters?: Record<string, any>; 
}

export interface SequentialScriptConfig extends BaseAgentConfig {
  strategyType: 'sequential_script';
  script: SequentialScriptEntry[];
}

/**
 * Sequential script entry - contains trigger and ordered steps
 * Multiple entries can chain together via user_query_answered triggers
 */
export interface SequentialScriptEntry {
  trigger: ScriptTrigger;
  steps: ScriptStep[];
}

/**
 * Individual step within a script entry
 * Steps execute in order until completion or user_query
 */
export type ScriptStep = ThoughtStep | ToolCallStep | UserQueryStep | ResponseStep;

export interface ThoughtStep {
  type: 'thought';
  content: string;
}

export interface ToolCallStep {
  type: 'tool_call';
  tool: {
    name: string;
    params: Record<string, any>;
  };
}

export interface UserQueryStep {
  type: 'user_query';
  question: string;
  context?: Record<string, any>; // Used for trigger matching in subsequent scripts
}

export interface ResponseStep {
  type: 'response';
  content: string;
}

/**
 * Enhanced trigger conditions with context matching support
 */
export interface ScriptTrigger {
  type: 'conversation_ready' | 'agent_turn' | 'user_query_answered';
  from?: string; // Agent ID for agent_turn triggers
  contains?: string; // Content matching for agent_turn triggers  
  context?: Record<string, any>; // Context matching for user_query_answered triggers
}

export type AgentConfig = 
  | StaticReplayConfig 
  | RuleBasedConfig 
  | ExternalProxyConfig
  | HybridConfig
  | ScenarioDrivenAgentConfig
  | SequentialScriptConfig;

// ============= Tool Definition =============

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
  };
  handler?: (params: any) => Promise<any>; // Optional local handler
  endpoint?: string; // Optional remote endpoint
}

// ============= Agent Interface =============

export interface AgentInterface {
  agentId: AgentId;
  config: AgentConfig;
  
  // Lifecycle
  initialize(conversationId: string, authToken: string): Promise<void>;
  shutdown(): Promise<void>;
  
  // Event handling
  onConversationEvent(event: any): Promise<void>;
  
  // Actions - Streaming approach
  startTurn(metadata?: Record<string, any>): Promise<string>; // Returns turnId
  addThought(turnId: string, thought: string): Promise<void>;
  addToolCall(turnId: string, toolName: string, parameters: any): Promise<string>; // Returns toolCallId
  addToolResult(turnId: string, toolCallId: string, result: any, error?: string): Promise<void>;
  completeTurn(turnId: string, content: string): Promise<void>;
  
  // User interaction
  queryUser(question: string, context?: Record<string, any>): Promise<string>;
}