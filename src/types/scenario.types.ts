// Scenario-Related Types
// This file contains all scenario and LLM integration types

// ============= Core Scenario Types (Schema v2.4) =============

export interface Tool {
  toolName: string;            // suffix encodes terminal outcome
  description: string;
  inputSchema: object;         // JSON Schema
  outputDescription: string;   // NL description of output
  synthesisGuidance: string;   // how to synthesize realistic results
}

export interface ScenarioConfiguration {
  scenarioMetadata: {
    id: string;
    title: string;
    schemaVersion: '2.4';
    description: string;
  };
  patientAgent: {
    principalIdentity: string; // The name of the human this agent represents (e.g., "Margaret Chen")
    systemPrompt: string;      // The prompt defining the AI assistant's role and goals
    clinicalSketch: Record<string, unknown>; // Ground truth for the principal - flexible payload
    tools: Tool[];
    behavioralParameters?: Record<string, unknown>; // flexible payload
    successCriteria?: string[];
    failureTriggers?: string[];
  };
  supplierAgent: {
    principalIdentity: string; // The name of the human this agent represents (e.g., "Alex Rivera")
    systemPrompt: string;
    operationalContext: Record<string, unknown>; // Ground truth for the principal's environment - flexible payload
    tools: Tool[];
    decisionFramework?: Record<string, unknown>; // flexible payload
  };
  interactionDynamics: {
    startingPoints: {
      PatientAgent: { objective: string };
      SupplierAgent: { objective: string };
    };
    criticalNegotiationPoints?: Array<{
      moment: string;
      patientView: string;
      supplierView: string;
    }>;
  };
}

// ============= Scenario Builder Types =============

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

export interface ScenarioItem {
  id: string;
  name: string;
  config: ScenarioConfiguration;
  history: ChatMessage[];
  created: number;
  modified: number;
}

// ============= LLM Integration Types =============

export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter';
}

export interface LLMTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface LLMToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMToolResponse {
  name: string;
  content: string;
  error?: string;
}

// ============= JSON Patch Types =============

export interface JSONPatchOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: any;
  from?: string; // for move/copy operations
}

// ============= Builder Tool Definitions =============

export const BUILDER_TOOLS: LLMTool[] = [
  {
    name: 'complete_turn',
    description: 'Complete your response to the user with an optional scenario update and mandatory message',
    inputSchema: {
      type: 'object',
      properties: {
        message: {
          type: 'string',
          description: 'Message to send to the user explaining what you did, asking for clarification, or providing guidance'
        },
        patches: {
          type: 'array',
          description: 'Optional array of RFC 6902 JSON Patch operations to apply to the scenario. These are applied client-side only.',
          items: {
            type: 'object',
            properties: {
              op: {
                type: 'string',
                enum: ['add', 'remove', 'replace', 'move', 'copy', 'test']
              },
              path: {
                type: 'string',
                description: 'JSON Pointer path to the target location'
              },
              value: {
                description: 'Value for add, replace, test operations'
              },
              from: {
                type: 'string',
                description: 'Source path for move/copy operations'
              }
            },
            required: ['op', 'path']
          }
        },
        replaceEntireScenario: {
          type: 'object',
          description: 'Optional complete replacement scenario configuration. Use only for major restructuring when patches would be too complex.'
        }
      },
      required: ['message']
    }
  }
];

// ============= Client Configuration Types =============

export interface LLMClientConfig {
  provider: 'google' | 'server';
  apiKey?: string; // for client-side calls
  model?: string;
  serverEndpoint?: string; // for server-side calls
}