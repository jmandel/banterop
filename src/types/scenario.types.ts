// Scenario-Related Types
// This file contains all scenario and LLM integration types

// **MAJOR CHANGE**: Import the definitive scenario types
import type { ScenarioConfiguration } from './scenario-configuration.types.js';
import { LLMMessage, LLMTool } from './llm.types.js';

// **DELETED**: The old `Tool` and `ScenarioConfiguration` interfaces are removed from this file.

// ============= Scenario Builder Types =============


export interface ScenarioItem {
  id: string;
  name: string;
  config: ScenarioConfiguration;
  history: LLMMessage[];
  created: number;
  modified: number;
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