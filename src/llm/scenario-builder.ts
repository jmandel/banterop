import { LLMProvider, LLMMessage, LLMToolCall, LLMToolResponse } from '../types/llm.types.js';
import { BUILDER_TOOLS, JSONPatchOperation, ScenarioConfiguration } from '$lib/types.js';

// Scenario Builder specific LLM service
export class ScenarioBuilderLLM {
  private llm: LLMProvider;
  
  constructor(llm: LLMProvider) {
    this.llm = llm;
  }
  
  async processUserMessage(
    userMessage: string,
    currentScenario: any,
    conversationHistory: LLMMessage[]
  ): Promise<{
    message: string;
    patches?: JSONPatchOperation[];
    replaceEntireScenario?: ScenarioConfiguration;
    toolCalls?: LLMToolCall[];
  }> {
    const systemPrompt = this.buildFullContextPrompt(currentScenario, conversationHistory);
    
    const messages: LLMMessage[] = [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage }
    ];
    
    let resultMessage = '';
    let appliedPatches: JSONPatchOperation[] = [];
    let replacementScenario: any = undefined;
    
    const toolHandler = async (call: LLMToolCall): Promise<LLMToolResponse> => {
      const result = this.handleToolCall(call, currentScenario);
      
      // Extract the response data from the complete_turn tool
      if (call.name === 'complete_turn') {
        if (typeof call.arguments.message === 'string') {
          resultMessage = call.arguments.message;
        }
        if (Array.isArray(call.arguments.patches)) {
          appliedPatches = call.arguments.patches as JSONPatchOperation[];
        }
        if (call.arguments.replaceEntireScenario) {
          replacementScenario = call.arguments.replaceEntireScenario;
        }
      }
      
      return result;
    };
    
    try {
      if (this.llm.generateWithTools) {
        const response = await this.llm.generateWithTools(messages, BUILDER_TOOLS, toolHandler);
        return {
          message: resultMessage || response.content,
          patches: appliedPatches.length > 0 ? appliedPatches : undefined,
          replaceEntireScenario: replacementScenario
        };
      } else {
        // Fallback to simple generation
        const response = await this.llm.generateResponse({ messages });
        return {
          message: response.content
        };
      }
    } catch (error) {
      // Only log in non-test environment
      console.error('Scenario builder LLM error:', error);
      return {
        message: `I encountered an error processing your request: ${error instanceof Error ? error.message : 'Unknown error'}. Please try rephrasing or use the direct JSON editor.`
      };
    }
  }
  
  private buildFullContextPrompt(currentScenario: any, conversationHistory: LLMMessage[]): string {
    // Format conversation history for context
    const formattedHistory = conversationHistory.length > 0 
      ? '\n\nCONVERSATION HISTORY:\n' + conversationHistory.map((msg, idx) => 
          `${idx + 1}. ${msg.role.toUpperCase()}: ${msg.content}`
        ).join('\n')
      : '\n\nCONVERSATION HISTORY: (This is the start of our conversation)';

    return `You are the Scenario Builder LLM for language-first interoperability. You help users modify ScenarioConfiguration JSON (schema v2.4) through natural conversation.

SYSTEM DESIGN:
This is a client-side editing experience. When you use the update_scenario tool, the changes are applied immediately in the browser but NOT saved to the backend. The user must explicitly click "Save" to persist changes. This gives users full control over when modifications are committed.

YOUR ROLE:
1. Understand user requests for scenario modifications
2. Use JSON Patch operations to make precise, targeted updates
3. Maintain the schema v2.4 structure while allowing flexible content in key fields
4. Provide clear explanations of what you're changing and why

KEY PRINCIPLES:
- The superstructure (metadata, scenario, agents[]) is fixed
- Each agent has: agentId, principal, situation, systemPrompt, goals, tools, knowledgeBase
- Agents can optionally have messageToUseWhenInitiatingConversation for starting conversations
- The messageToUseWhenInitiatingConversation allows any agent to initiate a conversation
- The knowledgeBase is the ground truth for each agent - never contradict it
- Tools with endsConversation: true determine scenario outcomes
- Always be helpful and explain your changes clearly
- Prefer targeted JSON Patch updates over complete rewrites
- Multiple small patches are better than one large replacement

AVAILABLE TOOLS:
You have exactly ONE tool: complete_turn
- Always use this tool to complete your response
- message (required): Explain what you did, ask for clarification, or provide guidance
- patches (optional): JSON Patch operations to apply to the scenario
- replaceEntireScenario (optional): Complete replacement scenario (use sparingly, only for major restructuring)

JSON PATCH EXAMPLES:
- Replace title: {"op": "replace", "path": "/metadata/title", "value": "New Title"}
- Add tool: {"op": "add", "path": "/agents/0/tools/-", "value": {...toolObject}}
- Remove tool: {"op": "remove", "path": "/agents/0/tools/0"}
- Set initiation message: {"op": "add", "path": "/agents/0/messageToUseWhenInitiatingConversation", "value": "Hello, I need help with..."}
- Update knowledge base: {"op": "replace", "path": "/agents/1/knowledgeBase/someKey", "value": "new value"}

CURRENT SCENARIO STRUCTURE:
- Title: ${currentScenario?.metadata?.title || 'Unknown'}
- Description: ${currentScenario?.metadata?.description || 'No description'}
- Number of agents: ${currentScenario?.agents?.length || 0}
- Agents: ${currentScenario?.agents?.map((a: any) => a.agentId?.label || a.agentId?.id || 'Unknown').join(', ') || 'None'}
- Total tools: ${currentScenario?.agents?.reduce((sum: number, a: any) => sum + (a.tools?.length || 0), 0) || 0}

COMPLETE CURRENT SCENARIO JSON:
\`\`\`json
${JSON.stringify(currentScenario, null, 2)}
\`\`\`

SCHEMA VALIDATION REQUIREMENTS:
- metadata must have title, schemaVersion: "2.4", description
- scenario must have background and challenges array
- agents must be an array where each agent has:
  - agentId with id and label
  - principal with name and description
  - situation, systemPrompt, goals array, tools array, knowledgeBase object
  - optional messageToUseWhenInitiatingConversation for conversation initiation${formattedHistory}

EXAMPLE USER REQUESTS AND RESPONSES:
- "Make the first agent start the conversation with 'Hello, I need help'"
  → Use patch: {"op": "add", "path": "/agents/0/messageToUseWhenInitiatingConversation", "value": "Hello, I need help"}
- "Let the supplier agent initiate by asking if the specialist is available"
  → Find supplier agent index, then patch its messageToUseWhenInitiatingConversation
- "Remove the initiation message from agent 2"
  → Use patch: {"op": "remove", "path": "/agents/1/messageToUseWhenInitiatingConversation"}

IMPORTANT: When using complete_turn with patches or replaceEntireScenario, changes are applied immediately in the browser but NOT saved to the backend until the user clicks "Save". Always explain what you're changing and remind users they can review changes before saving.

ALWAYS use the complete_turn tool for every response. Never respond without using this tool.`;
  }
  
  private async handleToolCall(call: LLMToolCall, currentScenario: any): Promise<LLMToolResponse> {
    switch (call.name) {
      case 'complete_turn':
        const message = call.arguments.message;
        const patches = call.arguments.patches;
        const replaceEntireScenario = call.arguments.replaceEntireScenario as ScenarioConfiguration;
        
        if (!message || typeof message !== 'string') {
          return {
            name: 'complete_turn',
            content: 'Error: Message is required',
            error: 'Message must be a non-empty string'
          };
        }
        
        // Validate patches if provided
        if (patches && Array.isArray(patches)) {
          for (const patch of patches) {
            if (!patch.op || !patch.path) {
              return {
                name: 'complete_turn',
                content: 'Error: Invalid patch operation',
                error: 'Each patch must have "op" and "path" properties'
              };
            }
            
            // Security validation: prevent modification of protected paths
            if (patch.path.startsWith('/metadata/id')) {
              return {
                name: 'complete_turn',
                content: 'Error: Cannot modify scenario ID',
                error: 'Scenario ID cannot be changed'
              };
            }
          }
        }
        
        // Validate replacement scenario if provided
        if (replaceEntireScenario) {
          if (typeof replaceEntireScenario !== 'object') {
            return {
              name: 'complete_turn',
              content: 'Error: Invalid replacement scenario',
              error: 'Replacement scenario must be an object'
            };
          }
          
          // Check required fields
          const required = ['metadata', 'scenario', 'agents'];
          for (const field of required) {
            if (!Object.prototype.hasOwnProperty.call(replaceEntireScenario, field)) {
              return {
                name: 'complete_turn',
                content: `Error: Missing required field ${field} in replacement scenario`,
                error: `Required field ${field} is missing`
              };
            }
          }
          
          // Validate agents is an array
          if (!Array.isArray(replaceEntireScenario.agents)) {
            return {
              name: 'complete_turn',
              content: 'Error: agents must be an array',
              error: 'The agents field must be an array'
            };
          }
        }
        
        return {
          name: 'complete_turn',
          content: `Turn completed successfully. Message: ${message}`
        };
        
      default:
        return {
          name: call.name,
          content: 'Unknown tool',
          error: `Tool ${call.name} is not supported`
        };
    }
  }
  
  // Utility method to suggest improvements to scenarios
  async suggestImprovements(scenario: any): Promise<string> {
    const analysisPrompt = `Analyze this scenario configuration and suggest improvements for realism and completeness:

${JSON.stringify(scenario, null, 2)}

Focus on:
1. Clinical accuracy in the clinicalSketch
2. Realistic tool definitions and synthesis guidance
3. Appropriate behavioral parameters
4. Clear success/failure criteria
5. Meaningful negotiation points

Provide 3-5 specific, actionable suggestions.`;

    try {
      const response = await this.llm.generateResponse({
        messages: [{ role: 'user', content: analysisPrompt }]
      });
      
      return response.content;
    } catch (error) {
      return `Unable to generate suggestions: ${error instanceof Error ? error.message : 'Unknown error'}`;
    }
  }
}