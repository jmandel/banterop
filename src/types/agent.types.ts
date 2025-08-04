// Agent Strategy Types and Configuration
// This file contains all agent-related type definitions

import { ThoughtEntry, ToolCallEntry, ToolResultEntry } from "./conversation.types";

// ============= Base Agent Types =============

// AgentId is now just a string
export type AgentId = string;

export type AgentStrategyType = 
  | 'static_replay' 
  | 'rule_based' 
  | 'external_proxy'
  | 'scenario_driven'
  | 'sequential_script'
  | 'bridge_to_external_mcp_client'
  | 'bridge_to_external_mcp_server'
  | 'bridge_to_external_a2a_client'
  | 'bridge_to_external_a2a_server'
  | 'external_websocket_client';

export interface BaseAgentConfig {
  id: string; // Simple string ID
  strategyType: AgentStrategyType;
  shouldInitiateConversation?: boolean;
  additionalInstructions?: string;
  bridgeConfig?: {
    externalServerUrl?: string;
  };
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

export interface ScenarioDrivenAgentConfig extends BaseAgentConfig {
  strategyType: 'scenario_driven';
  scenarioId?: string; // Optional for scenario-driven agents
  scenarioVersionId?: string; // Optional: to pin a specific version
  // Flexible parameters to allow for variations within a single scenario
  parameters?: Record<string, any>; 
}

export interface SequentialScriptConfig extends BaseAgentConfig {
  strategyType: 'sequential_script';
  script: SequentialScriptEntry[];
}

export interface ExternalWebSocketClientConfig extends BaseAgentConfig {
  strategyType: 'external_websocket_client';
}

export interface BridgeToExternalMCPClientConfig extends BaseAgentConfig {
  strategyType: 'bridge_to_external_mcp_client';
}

export interface BridgeToExternalMCPServerConfig extends BaseAgentConfig {
  strategyType: 'bridge_to_external_mcp_server';
}

export interface BridgeToExternalA2AClientConfig extends BaseAgentConfig {
  strategyType: 'bridge_to_external_a2a_client';
}

export interface BridgeToExternalA2AServerConfig extends BaseAgentConfig {
  strategyType: 'bridge_to_external_a2a_server';
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
  | ScenarioDrivenAgentConfig
  | SequentialScriptConfig
  | ExternalWebSocketClientConfig
  | BridgeToExternalMCPClientConfig
  | BridgeToExternalMCPServerConfig
  | BridgeToExternalA2AClientConfig
  | BridgeToExternalA2AServerConfig;

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
  agentId: string; // Simple string ID
  config: AgentConfig;
  
  // Lifecycle
  initialize(conversationId: string, authToken: string): Promise<void>;
  shutdown(): Promise<void>;
  
  // Event handling
  onConversationEvent(event: any): Promise<void>;
  
  // Conversation initiation
  initializeConversation(instructions?: string): Promise<void>;
  
  // Process and reply to a turn
  processAndReply(previousTurn: any): Promise<void>;
  
  // User interaction
  queryUser(question: string, context?: Record<string, any>): Promise<string>;
}