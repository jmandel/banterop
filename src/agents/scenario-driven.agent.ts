// Scenario-Driven Agent Implementation

import type { OrchestratorClient } from '$client/index.js';
import {
  Conversation,
  ConversationEvent,
  ConversationTurn,
  LLMProvider, LLMMessage, LLMRequest,
  ScenarioDrivenAgentConfig,
  TraceEntry,
  TurnCompletedEvent,
  ToolResultEntry,
  ThoughtEntry,
  ToolCallEntry,
  Attachment,
  AttachmentPayload
} from '$lib/types.js';
import type { ScenarioConfiguration, AgentConfiguration, Tool } from '$lib/types.js';
import { ParsedResponse, parseToolsFromResponse } from '$lib/utils/tool-parser.js';
import { BaseAgent } from './base.agent.js';
import { ToolSynthesisService } from './services/tool-synthesis.service.js';
export { type ScenarioDrivenAgentConfig } from "$lib/types.js";

interface ToolCall {
  name: string,
  args?: Record<string,unknown>
}

export class ScenarioDrivenAgent extends BaseAgent {
  private scenario: ScenarioConfiguration;
  private agentConfig: AgentConfiguration;
  private llmProvider: LLMProvider;
  private toolSynthesis: ToolSynthesisService;
  private processingTurn: boolean = false;
  
  private availableDocuments: Map<string, any> = new Map(); // Map of docId to document object

  constructor(
    config: ScenarioDrivenAgentConfig, 
    client: OrchestratorClient,
    scenario: ScenarioConfiguration,
    llmProvider: LLMProvider,
    toolSynthesisService: ToolSynthesisService
  ) {
    super(config, client);
    this.llmProvider = llmProvider;
    this.toolSynthesis = toolSynthesisService;
    this.scenario = scenario;

    const myConfig = this.scenario.agents.find(a => a.agentId.id === this.agentId.id);
    if (!myConfig) {
      throw new Error(`Agent ID ${this.agentId.id} not found in scenario ${config.scenarioId}`);
    }
    this.agentConfig = myConfig;

    const builtInTools = this.getBuiltInTools();
    this.agentConfig.tools = [...builtInTools, ...this.agentConfig.tools];

    // Apply any additional parameters from the config if needed
    if (config.parameters) {
      // Could modify the loaded scenario based on parameters
      // For now, we just store the scenario as-is
    }
  }

  async initialize(conversationId: string, authToken: string): Promise<void> {
    // Call parent initialization first - BaseAgent now handles all state management
    await super.initialize(conversationId, authToken);
    
    // ONE-TIME-FETCH to hydrate state on startup
    const initialConversation = await this.client.getConversation();
    
    // Extract available documents from all turns (BaseAgent handles turns/traces/attachments)
    this.availableDocuments.clear();
    
    const turns = this.getTurns();
    for (const turn of turns) {
        const traces = this.getTraceForTurn(turn.id);
        for (const entry of traces) {
            if (entry.type === 'tool_result' && (entry as ToolResultEntry).result) {
                const documents = this.extractDocuments((entry as ToolResultEntry).result);
                for (const [docId, doc] of documents) {
                    this.availableDocuments.set(docId, doc);
                }
            }
        }
    }

    if (initialConversation.metadata.initiatingAgentId === this.agentId.id) {
    }
    else {
    }

  }

  async onConversationEvent(event: ConversationEvent): Promise<void> {
    // Let BaseAgent handle the main event processing
    await super.onConversationEvent(event);

    // Handle specific events for document extraction
    switch (event.type) {
        case 'turn_completed':
            const completedTurn = event.data.turn as ConversationTurn;
            
            // Extract all documents from this turn's trace
            if (completedTurn.trace && completedTurn.trace.length > 0) {
                for (const entry of completedTurn.trace) {
                    if (entry.type === 'tool_result' && (entry as ToolResultEntry).result) {
                        const documents = this.extractDocuments((entry as ToolResultEntry).result);
                        for (const [docId, doc] of documents) {
                            this.availableDocuments.set(docId, doc);
                        }
                    }
                }
            }
            break;

        case 'trace_added':
            const trace = event.data.trace as TraceEntry;
            // Extract documents from new trace entries
            if (trace.type === 'tool_result' && (trace as ToolResultEntry).result) {
                const documents = this.extractDocuments((trace as ToolResultEntry).result);
                for (const [docId, doc] of documents) {
                    this.availableDocuments.set(docId, doc);
                }
            }
            break;
    }
  }

  async initializeConversation(instructions?: string): Promise<void> {
    if (!this.agentConfig.messageToUseWhenInitiatingConversation) {
      console.warn(`Agent ${this.agentId.label} cannot initiate without a configured message.`);
      return;
    }
    
    await this.startTurn();
    let thought = `I will start the conversation. My default message is: "${this.agentConfig.messageToUseWhenInitiatingConversation}".`;
    if (instructions) {
      thought += ` Special instructions: "${instructions}"`;
    }
    await this.addThought(thought);

    let messageToSend = this.agentConfig.messageToUseWhenInitiatingConversation;

    if (instructions) {
      // Use LLM to potentially revise the opening message based on instructions.
      const prompt = this.constructFullPrompt({
        agentConfig: this.agentConfig,
        tools: this.agentConfig.tools,
        conversationHistory: `INSTRUCTIONS FOR THIS CONVERSATION: ${instructions}\n\nYou are about to start a conversation. Your configured initial message is: "${messageToSend}"\n\nConsider if you need to adjust this message based on the instructions provided.`,
        currentProcess: ''
      });
      const result = await this.extractToolCallsFromLLMResponse(prompt);
      if (result.tools && result.tools.length === 1 && result.tools[0].name === 'send_message_to_agent_conversation') {
        messageToSend = result.tools[0].args.text || messageToSend;
      }
    }
    
    await this.completeTurn(messageToSend);
  }

  async processAndReply(previousTurn: ConversationTurn): Promise<void> {
    // This delegates to the existing _processAndRespondToTurn method
    await this._processAndRespondToTurn(previousTurn);
  }


   async _processAndRespondToTurn(triggeringTurn: ConversationTurn): Promise<void> {
    if (this.processingTurn) return; // Prevent concurrent processing
    this.processingTurn = true;

    try {
      await this.startTurn();
      
      let MAX_STEPS = 10;
      let stepCount = 0;
      while (stepCount++ < MAX_STEPS) {
          const historyString = this.buildConversationHistory();
          const currentProcessString = this.formatCurrentProcess(this.getCurrentTurnTrace());
          
          const remainingSteps = MAX_STEPS - stepCount + 1;
          const prompt = this.constructFullPrompt({
              agentConfig: this.agentConfig,
              tools: this.agentConfig.tools,
              conversationHistory: historyString,
              currentProcess: currentProcessString,
              remainingSteps
          });
          
          // The rest of the agent's logic proceeds from here
          let result;
          try {
            result = await this.extractToolCallsFromLLMResponse(prompt);
          } catch (llmError) {
            console.error("LLM request failed:", llmError);
            await this.addThought(`LLM request failed: ${llmError.message}. I'll try to recover gracefully.`);
            await this.completeTurn("I apologize, but I encountered a technical issue. Please try again later.");
            break;
          }
          
          if (!result.tools || !result.message) {
            console.error("Missing thoughts or tools, ending turn")
            await this.completeTurn("Turn ended with error");
            this.client.endConversation(this.conversationId)
            break;
          }

          await this.addThought(result.message);

          const stepResult = await this.executeSingleToolCallWithReasoning(result);
          if (stepResult.completedTurn) {
            break;
          }
        }
        if (stepCount > MAX_STEPS) {
          console.error("MAX STEPS reaached, bailing")
          try {
            await this.completeTurn("Error: Max steps reached");
          } catch (error) {
            // Turn might have already been completed by a terminal tool
          }
        }
    } catch (error) {
      console.error("Error in _processAndRespondToTurn:", error);
      try {
        await this.completeTurn("I encountered an unexpected error and need to end this conversation.");
      } catch (completeError) {
        console.error("Failed to complete turn after error:", completeError);
      }
    } finally {
      this.processingTurn = false;
    }
  }

  private buildConversationHistory(): string {
    const sections: string[] = [];
    
    // Process turns chronologically
    const turns = this.getTurns();
    for (const turn of turns) {
      if (turn.agentId === this.agentId.id) {
        // Our own turn - use detailed formatting with scratchpad and tool calls
        sections.push(this.formatOwnTurnForHistory(turn));
      } else {
        // Other agent's turn - simple timestamp and content
        sections.push(this.formatOtherAgentTurn(turn));
      }
    }
    
    return sections.join('\n\n');
  }


  /**
   * Formats tools with usage guidance for better decision making.
   */
  private formatToolsWithGuidance(tools: Tool[]): string {
    const communicationTools = tools.filter(t => 
      ['send_message_to_agent_conversation', 'ask_question_to_principal', 'no_response_needed'].includes(t.toolName)
    );
    const actionTools = tools.filter(t => 
      !['send_message_to_agent_conversation', 'ask_question_to_principal', 'no_response_needed'].includes(t.toolName)
    );

    let sections: string[] = [];

    if (communicationTools.length > 0) {
      sections.push('📨 Communication Tools:');
      sections.push(communicationTools.map(tool => this.formatSingleTool(tool)).join('\n'));
    }

    if (actionTools.length > 0) {
      const terminalTools = actionTools.filter(t => t.endsConversation);
      const nonTerminalTools = actionTools.filter(t => !t.endsConversation);

      if (nonTerminalTools.length > 0) {
        sections.push('\n🔧 Action Tools:');
        sections.push(nonTerminalTools.map(tool => this.formatSingleTool(tool)).join('\n'));
      }

      if (terminalTools.length > 0) {
        sections.push('\n🏁 Terminal Tools (these end the conversation):');
        sections.push(terminalTools.map(tool => this.formatSingleTool(tool)).join('\n'));
      }
    }

    return sections.join('\n');
  }

  private formatSingleTool(tool: Tool): string {
    const params = tool.inputSchema?.properties
      ? Object.entries(tool.inputSchema.properties).map(([p, s]: [string, any]) => {
          const isRequired = tool.inputSchema?.required?.includes(p);
          return `${p}: ${s.type}${isRequired ? ' (required)' : ''}`;
        }).join(', ')
      : '';
    
    const terminalMarker = tool.endsConversation ? ' [TERMINAL]' : '';
    return `• ${tool.toolName}(${params})${terminalMarker}\n  └─ ${tool.description}`;
  }


  // Construct the full prompt for the LLM using optimal ordering and XML delimiters
  private constructFullPrompt(params: {
    agentConfig: AgentConfiguration;
    tools: Tool[];
    conversationHistory?: string;
    currentProcess?: string;
    remainingSteps?: number;
  }): string {
    const { agentConfig, tools, conversationHistory, currentProcess, remainingSteps } = params;

    const separator = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

    const systemPromptSection = `<SYSTEM_PROMPT>
You are an AI agent in a healthcare interoperability scenario.

Principal: ${agentConfig.principal.name}
└─ ${agentConfig.principal.description}

Role: ${agentConfig.agentId.label}
Situation: ${agentConfig.situation}

Instructions: ${agentConfig.systemPrompt}

Goals:
${agentConfig.goals.map(g => `• ${g}`).join('\n')}

</SYSTEM_PROMPT>`;
    

    // 2. Tools Section with usage guidance
    const toolsSection = `<AVAILABLE_TOOLS>
You have access to the following tools. Each tool must be called with all required parameters.

${this.formatToolsWithGuidance(tools)}

ATTACHMENT GUIDANCE:
- ANY tool response that has a "docId" field at the root level is an attachable document. You can attach it directly without any additional resolution.
- Tool responses with "refToDocId" (instead of "docId") are references that need to be resolved first using resolve_document_reference.
- Simple rule: If you see "docId" at the root of any tool result, that's a document you can attach. Only "refToDocId" needs resolution.
- To attach documents in your messages:
  1. Collect the docIds from tool results (no resolution needed if docId already exists)
  2. Use send_message_to_agent_conversation with attachments_to_include as an array of docId strings
  Example: attachments_to_include: ["doc_policy_123", "doc_report_456"]
- You can only attach documents whose docId has appeared in a tool result within this conversation.
- Never claim "see attached" without including actual attachments.

</AVAILABLE_TOOLS>`;

    // Use new chronological format if available, otherwise fall back to old format
    let conversationHistorySection: string = `<CONVERSATION_HISTORY>
${conversationHistory}
</CONVERSATION_HISTORY>`;

    // Current status section with process details
    let currentStatusSection = currentProcess ? `<CURRENT_STATUS>
You are currently in the middle of processing a turn. Review your progress below.

${currentProcess}

</CURRENT_STATUS>` : '';

    // Add warning if approaching MAX_STEPS
    if (remainingSteps !== undefined && remainingSteps <= 5) {
      const warningSection = `
<IMPORTANT_WARNING>
⚠️ You have only ${remainingSteps} step${remainingSteps === 1 ? '' : 's'} remaining in this turn!
You MUST send a message to the conversation thread using send_message_to_agent_conversation before your steps run out.
If you don't send a message before reaching 0 steps, the turn will end with an error.
</IMPORTANT_WARNING>`;
      currentStatusSection = warningSection + currentStatusSection;
    }

    // 5. Response Instructions Section (How do I respond?)
    const responseInstructionsSection = `<RESPONSE_INSTRUCTIONS>
Your response MUST follow this EXACT format:

<scratchpad>
[Your step-by-step reasoning here. Consider:
 - What just happened in the conversation?
 - What information do you need?
 - What is the most appropriate next action?
 - Which tool should you use and why?]
</scratchpad>

\`\`\`json
{
  "name": "tool_name_here",
  "args": {
    "parameter1": "value1",
    "parameter2": "value2"
  }
}
\`\`\`

⚠️ CRITICAL: Include BOTH the <scratchpad> reasoning AND the JSON tool call. No other text.

</RESPONSE_INSTRUCTIONS>`;

    const sections = [
      systemPromptSection,
      separator,
      toolsSection,
      separator,
      conversationHistorySection,
      currentStatusSection,
      separator,
      responseInstructionsSection,
      '',
      "🎯 Now, provide your response following the instructions above."
    ].filter(s => s !== null && s !== undefined);

    return sections.join('\n\n');
  }

  // Extract tool calls from LLM response with reasoning capture
  private async extractToolCallsFromLLMResponse(prompt: string): Promise<ParsedResponse> {
    const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
    const request: LLMRequest = {
      messages,
    };

    const response = await this.llmProvider.generateResponse(request);
    const responseContent = response.content;
    return parseToolsFromResponse(responseContent)
  }

  // Execute single tool call with reasoning capture (following single-action constraint)
  private async executeSingleToolCallWithReasoning(result: ParsedResponse): Promise<{completedTurn: boolean}> {
    const { message, tools } = result;
    
    // Handle case where no tool call was made
    if (!tools || tools.length !== 1) {
      return {completedTurn: false};
    }
    const toolCall = tools[0]

    // Handle built-in communication tools
    if (toolCall.name === 'no_response_needed') {
      await this.completeTurn("No response");
      return {completedTurn: true};
    }

    if (toolCall.name === 'send_message_to_agent_conversation') {
      const { text, attachments_to_include } = toolCall.args;
      if (!text || typeof text !== 'string' || text.trim() === '') {
        const error = new Error(`${this.agentId.id}: send_message_to_agent_conversation requires non-empty text parameter. Got: ${JSON.stringify(toolCall.args)}`);
        console.error('Stack trace:', error.stack);
        throw error;
      }
      
      const attachmentPayloads: AttachmentPayload[] = [];
      
      // Process attachments if provided (now an array of docIds)
      if (attachments_to_include && Array.isArray(attachments_to_include) && attachments_to_include.length > 0) {
        
        // Handle case where LLM sends objects instead of strings
        const docIds = attachments_to_include.map(item => {
          if (typeof item === 'string') {
            return item;
          } else if (typeof item === 'object' && item.docId) {
            console.warn(`[${this.agentId.id}] Received object with docId instead of string. Converting...`);
            return item.docId;
          } else {
            console.error(`[${this.agentId.id}] Invalid attachment format:`, item);
            return null;
          }
        }).filter(id => id !== null);
        
        // Create a Set of all available docIds from the entire conversation
        const availableDocIds = new Set<string>();
        
        // Use the availableDocuments map which already has all documents from all turns
        for (const docId of this.availableDocuments.keys()) {
          availableDocIds.add(docId);
        }
        
        // Filter to keep only valid docIds
        const validDocIds = docIds.filter(docId => availableDocIds.has(docId));
        
        if (validDocIds.length < docIds.length) {
          console.warn(`Some docIds were not found in conversation history. Requested: ${docIds.join(', ')}, Valid: ${validDocIds.join(', ')}`);
        }
        
        // Process each valid docId
        for (const docId of validDocIds) {
          try {
            // Get the document from our map
            const doc = this.availableDocuments.get(docId);
            
            if (!doc) {
              console.error(`Could not find document with docId: ${docId}`);
              continue;
            }
            
            // Skip if content is null/undefined/empty
            if (!doc.content) {
              console.warn(`Skipping attachment ${docId} due to missing content`);
              continue;
            }
            
            // Create attachment payload
            const payload: AttachmentPayload = {
              docId: docId,
              name: doc.name || docId,
              contentType: doc.contentType || 'text/markdown',
              content: typeof doc.content === 'string' ? doc.content : JSON.stringify(doc.content),
              summary: doc.summary
            };
            
            attachmentPayloads.push(payload);
          } catch (error) {
            console.error(`Failed to process attachment ${docId}:`, error);
            // Continue with other attachments
          }
        }
      }
      
      await this.completeTurn(text, false, attachmentPayloads);
      return {completedTurn: true};
    }

    if (toolCall.name === 'ask_question_to_principal') {
      const { text } = toolCall.args;
      if (!text || typeof text !== 'string' || text.trim() === '') {
        const error = new Error(`${this.agentId.id}: ask_question_to_principal requires non-empty text parameter. Got: ${JSON.stringify(toolCall.args)}`);
        console.error('Stack trace:', error.stack);
        throw error;
      }
      
      // Add tool call trace BEFORE waiting
      const toolCallId = await this.addToolCall(toolCall.name, toolCall.args);
      
      // Query the user and wait for response
      const userResponse = await this.queryUser(text);
      
      // Add tool result trace AFTER getting the response
      await this.addToolResult(toolCallId, userResponse);
      
      // Turn remains open, agent can continue processing
      return {completedTurn: false};
    }

    
    // Add tool call trace
    const toolCallId = await this.addToolCall(toolCall.name, toolCall.args);
    
    try {
      const toolDef = this.getToolDefinition(toolCall.name);
      
      let toolOutput: any;
      
      // Special handling for resolve_document_reference - check if document already exists
      if (toolCall.name === 'resolve_document_reference' && toolCall.args.refToDocId) {
        // First check if we already have this document as an attachment
        const existingAttachment = await this.checkExistingAttachment(toolCall.args.refToDocId as string);
        
        if (existingAttachment) {
          toolOutput = {
            docId: existingAttachment.docId,
            name: existingAttachment.name,
            contentType: existingAttachment.contentType,
            content: existingAttachment.content,
            summary: existingAttachment.summary
          };
        }
      }
      
      // If we didn't find an existing attachment, call synthesis
      if (!toolOutput) {
        // Build conversation history including the current in-progress turn
        const historyString = this.buildConversationHistory();
        const currentProcessString = this.formatCurrentProcess(this.getCurrentTurnTrace());
        const fullHistory = historyString + (historyString ? '\n\n' : '') + 
                           `From: ${this.agentId.label} (IN PROGRESS)\n` +
                           `Timestamp: ${new Date().toISOString()}\n\n` +
                           currentProcessString;
        
        try {
          const synthesisResult = await this.toolSynthesis.execute({ // New call
              toolName: toolCall.name,
              args: toolCall.args,
              agentId: this.agentId.id,
              scenario: this.scenario,
              conversationHistory: fullHistory
          });
          
          toolOutput = synthesisResult.output;
        } catch (toolError) {
          console.error(`Tool synthesis failed for ${toolCall.name}:`, toolError);
          toolOutput = {
            error: `Tool execution failed: ${toolError.message}`,
            success: false
          };
          await this.addToolResult(toolCallId, toolOutput, toolError.message);
          return {completedTurn: false};
        }
      }

      // Reification Logic: Wrap tool output in document structure if it doesn't have a docId
      if (toolOutput && (typeof toolOutput !== 'object' || !toolOutput.hasOwnProperty('docId'))) {
        toolOutput = {
          docId: toolCallId, // Use the toolCallId as the docId
          contentType: 'application/json',
          content: toolOutput
        };
      }
      
      
      // Extract all documents with docIds from the tool output (including nested ones)
      const documentsInResult = this.extractDocuments(toolOutput);
      if (documentsInResult.size > 0) {
        // Add all found documents to our available documents map
        for (const [docId, doc] of documentsInResult) {
          this.availableDocuments.set(docId, doc);
        }
      }
      
      await this.addToolResult(toolCallId, toolOutput);
      
      if (toolDef?.endsConversation) {
        const resultMessage = `Action complete. Result: ${JSON.stringify(toolOutput)}`;
        await this.completeTurn(resultMessage, true);
        
        if (this.conversationId) {
            await this.client.endConversation(this.conversationId);
        }
        return {completedTurn: true}
      } 

      return {completedTurn: false}
    } catch (error: any) {
      // Add error trace
      await this.addToolResult(toolCallId, null, error.message);
      
      // Complete turn with error response
      await this.completeTurn(`I encountered an error: ${error.message}`);
      console.error("Error", error)
      console.trace()
      return {completedTurn: true};
    }
  }

  private getToolDefinition(toolName: string): Tool | undefined {
    return this.agentConfig.tools.find(tool => tool.toolName === toolName);
  }

  /**
   * Recursively extracts all documents with docIds and builds a map
   */
  private extractDocuments(obj: any, docMap: Map<string, any> = new Map()): Map<string, any> {
    if (!obj || typeof obj !== 'object') {
      return docMap;
    }

    // If this object has a docId, add it to the map
    if (obj.docId && typeof obj.docId === 'string') {
      docMap.set(obj.docId, obj);
    }

    // Recursively search arrays and objects
    if (Array.isArray(obj)) {
      for (const item of obj) {
        this.extractDocuments(item, docMap);
      }
    } else {
      for (const key of Object.keys(obj)) {
        this.extractDocuments(obj[key], docMap);
      }
    }

    return docMap;
  }
  
  /**
   * Public method to populate documents from trace (for testing)
   */
  public populateDocumentsFromTrace(trace: TraceEntry[]): void {
    for (const entry of trace) {
      if (entry.type === 'tool_result' && (entry as ToolResultEntry).result) {
        const documents = this.extractDocuments((entry as ToolResultEntry).result);
        for (const [docId, doc] of documents) {
          this.availableDocuments.set(docId, doc);
        }
      }
    }
  }

  /**
   * Recursively finds a document by docId within a nested structure
   */
  private findDocumentByDocId(obj: any, targetDocId: string): any | null {
    if (!obj || typeof obj !== 'object') {
      return null;
    }

    // If this object has the target docId, return it
    if (obj.docId === targetDocId) {
      return obj;
    }

    // Recursively search arrays and objects
    if (Array.isArray(obj)) {
      for (const item of obj) {
        const found = this.findDocumentByDocId(item, targetDocId);
        if (found) return found;
      }
    } else {
      for (const key of Object.keys(obj)) {
        const found = this.findDocumentByDocId(obj[key], targetDocId);
        if (found) return found;
      }
    }

    return null;
  }

  private async checkExistingAttachment(docId: string): Promise<Attachment | null> {
    try {
      // Check if we have this document in our local map
      const doc = this.availableDocuments.get(docId);
      if (doc) {
        // Convert to Attachment format if found
        return {
          id: doc.id || docId,
          docId: docId,
          name: doc.name || docId,
          contentType: doc.contentType || 'text/markdown',
          content: doc.content,
          summary: doc.summary
        } as Attachment;
      }
      return null;
    } catch (error) {
      console.error(`Failed to check existing attachment for docId ${docId}:`, error);
      return null;
    }
  }

  // Format tool response for the conversation
  private formatToolResponse(toolName: string, result: any): string {
    const isTerminal = this.isTerminalTool(toolName);
    
    if (isTerminal) {
      // Terminal tools end the conversation
      return `I have completed my action using ${toolName}. Result: ${JSON.stringify(result)}`;
    } else {
      // Non-terminal tools continue the conversation
      return `I used ${toolName} and got: ${JSON.stringify(result)}. How would you like to proceed?`;
    }
  }

  private isTerminalTool(toolName: string): boolean {
    const toolDef = this.getToolDefinition(toolName);
    return toolDef?.endsConversation ?? false;
  }

  // Get built-in communication tools (copied from AgentRuntime)
  private getBuiltInTools(): Partial<Tool[]> & Pick<Tool, 'toolName'| 'description'| 'inputSchema'>[] {
    return [
      {
        toolName: 'send_message_to_agent_conversation',
        description: 'Send a message to the other agent you are conversing with, starting/continuing your conversation',
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1 },
            attachments_to_include: { 
              type: 'array',
              description: 'Array of document IDs (strings) to include as attachments. You must have previously read these documents in this turn using resolve_document_reference.',
              items: { type: 'string' }
            }
          }
        },
        synthesisGuidance: 'N/A'
      },
      {
        toolName: 'ask_question_to_principal',
        description: 'Last Resort: Send a message or question to the human principal this agent represents. Only use this as a last resort, if information is unavailable from other agents in conversation thread or from other tools.',
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1 },
            uiSchema: { type: 'object' },
            expectReply: { type: 'boolean' }
          }
        },
        synthesisGuidance: 'Respond as the user might'
      },
      {
        toolName: 'resolve_document_reference',
        description: 'Read the full content of a document/attachment that was described in a tool result. Call this before including any attachment in your message.',
        inputSchema: {
          type: 'object',
          required: ['refToDocId'],
          properties: {
            refToDocId: { type: 'string', description: 'Reference ID of the document to read' },
            name: { type: 'string', description: 'Document name' },
            type: { type: 'string', description: 'Document type' },
            contentType: { type: 'string', description: 'MIME type (default: text/markdown)' },
            summary: { type: 'string', description: 'Summary of the document' },
            details: { type: 'object', description: 'Additional details for synthesis' }
          }
        },
        synthesisGuidance: 'Generate the full text content of the described document based on the scenario context and provided details'
      },
      // {
      //   toolName: 'no_response_needed',
      //   description: 'Use this when no action or response is needed in the current situation',
      //   inputSchema: {
      //     type: 'object',
      //     properties: {}
      //   },
      //   synthesisGuidance: 'Agent chose not to respond to the current situation'
      // }
    ];
  }

  // Format tool use for conversation display with budget management
  private formatToolUseForConversation(trace: any, budgetWords: number): string | null {
    if (!trace || !trace.steps) return null;
    
    const steps = trace.steps;
    const toolCall = steps.find((s: any) => s.type === 'tool_call');
    const toolResult = steps.find((s: any) => s.type === 'tool_result');
    const reasoning = steps.find((s: any) => s.type === 'thought' && s.label === 'Agent reasoning');
    
    // Build full tool use text
    const sections: string[] = [];
    
    if (reasoning && reasoning.detail) {
      sections.push(`  REASONING: ${reasoning.detail}`);
    }
    
    if (toolCall) {
      sections.push(`  TOOL: ${toolCall.label}${toolCall.data ? '(' + JSON.stringify(toolCall.data) + ')' : ''}`);
    }
    
    if (toolResult) {
      const resultText = toolResult.data ? JSON.stringify(toolResult.data) : toolResult.label;
      sections.push(`  RESULT: ${resultText}`);
    }
    
    const fullText = sections.join('\n');
    const fullWords = this.countWords(fullText);
    
    // If within budget, return full text
    if (fullWords <= budgetWords) {
      return fullText;
    }
    
    // If over budget, try to fit essential parts
    const essentialSections: string[] = [];
    
    if (toolCall) {
      essentialSections.push(`  TOOL: ${toolCall.label}`);
    }
    
    if (toolResult) {
      essentialSections.push(`  RESULT: ${toolResult.label}`);
    }
    
    const essentialText = essentialSections.join('\n');
    const essentialWords = this.countWords(essentialText);
    
    // If essential parts fit, use them
    if (essentialWords <= budgetWords) {
      return essentialText + '\n  [tool use details snipped to save space]';
    }
    
    // Otherwise, just indicate tool use was snipped
    return '  [tool use snipped to save space]';
  }

  // Format execution trace for context inclusion (used for budget calculation)
  private formatTraceForContext(trace: TraceEntry): string {
      switch (trace.type) {
        case 'thought':
          return `THOUGHT: ${trace.content}`
        case 'tool_call':
          return `TOOL_CALL: <${trace.toolName}>${JSON.stringify(trace.parameters)}</${trace.toolName}>`
        case 'tool_result':
          return `TOOL_RESULT: ${JSON.stringify(trace.result)}`
        default:
          throw new Error("Unrecognized trace type")
      }
  }

  // Format trace entry for display (legacy method)
  private formatTraceEntry(entry: TraceEntry): string {
    switch (entry.type) {
      case 'thought':
        return (entry as any).content;
      case 'tool_call':
        const toolCall = entry as any;
        return `${toolCall.toolName}(${JSON.stringify(toolCall.parameters)})`;
      case 'tool_result':
        const toolResult = entry as any;
        return toolResult.error || JSON.stringify(toolResult.result);
      default:
        return JSON.stringify(entry);
    }
  }

  // Count words in text for token budget management
  private countWords(text: string): number {
    return text.split(/\\s+/).length;
  }

  // ============= Turn Formatting Helpers =============

  private formatTimestamp(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    // Example format: 2024-07-01 10:30:15
    return d.toISOString().replace('T', ' ').substring(0, 19);
  }

  private formatTurnAttachments(turnId: string): string {
    const attachments = this.getAttachmentsForTurn(turnId);
    if (!attachments || attachments.length === 0) return '';
    
    const attachmentDetails: string[] = [];
    attachmentDetails.push('\n\n📎 Attachments:');
    
    // Use stored attachment metadata
    for (const attachment of attachments) {
      attachmentDetails.push(`• ${attachment.name || 'Untitled Document'} (docId: ${attachment.docId || attachment.id})`);
      if (attachment.summary) {
        attachmentDetails.push(`  Summary: ${attachment.summary}`);
      }
      attachmentDetails.push(`  💡 Use resolve_document_reference with refToDocId: "${attachment.docId || attachment.id}" to read this document`);
    }
    
    return attachmentDetails.join('\n');
  }

  private formatOtherAgentTurn(turn: ConversationTurn): string {
    const timestamp = this.formatTimestamp(turn.timestamp);
    let formatted = `From: ${turn.agentId}\nTimestamp: ${timestamp}\n\n${turn.content}`;
    
    // Add attachments if present
    if (turn.attachments && turn.attachments.length > 0) {
      formatted += this.formatTurnAttachments(turn.id);
    }
    
    return formatted + '\n\n---';
  }

  private formatOwnTurnForHistory(turn: ConversationTurn): string {
    const timestamp = this.formatTimestamp(turn.timestamp);
    const turnTraces = this.getTraceForTurn(turn.id);

    const parts: string[] = [
      `From: ${this.agentId.id}`,
      `Timestamp: ${timestamp}`,
      '' // Empty line after headers
    ];
    let currentScratchpad: string[] = [];
    
    // Process traces in order (already chronological)
    for (const trace of turnTraces) {
      switch (trace.type) {
        case 'thought':
          currentScratchpad.push((trace as ThoughtEntry).content);
          break;
          
        case 'tool_call':
          // Output any accumulated thoughts first
          if (currentScratchpad.length > 0) {
            parts.push(`<scratchpad>\n${currentScratchpad.join('\n')}\n</scratchpad>`);
            currentScratchpad = [];
          }
          
          // Output the tool call
          const toolCall = trace as ToolCallEntry;
          const toolCallJson = JSON.stringify({ name: toolCall.toolName, args: toolCall.parameters }, null, 2);
          parts.push(`\`\`\`json\n${toolCallJson}\n\`\`\``);
          break;
          
        case 'tool_result':
          // Output the tool result
          const toolResult = trace as ToolResultEntry;
          const resultJson = toolResult.error ? `{ "error": "${toolResult.error}" }` : JSON.stringify(toolResult.result);
          parts.push(`[TOOL_RESULT] ${resultJson}`);
          break;
      }
    }
    
    // Output any remaining thoughts
    if (currentScratchpad.length > 0) {
      parts.push(`<scratchpad>\n${currentScratchpad.join('\n')}\n</scratchpad>`);
    }
    
    // Add the final turn content
    if (turn.content) {
      parts.push(turn.content);
    }
    
    // Add attachments if present
    if (turn.attachments && turn.attachments.length > 0) {
      parts.push(this.formatTurnAttachments(turn.id));
    }

    // Add separator at the end
    parts.push('', '---');

    return parts.join('\n');
  }

  private formatCurrentProcess(currentTurnTrace: TraceEntry[]): string {
    if (currentTurnTrace.length === 0) {
        return `<!-- No actions taken yet in this turn -->
***=>>YOU ARE HERE<<=***`;
    }

    const steps: string[] = [];
    let i = 0;
    
    while (i < currentTurnTrace.length) {
      const trace = currentTurnTrace[i];
      
      if (trace.type === 'thought') {
        // Collect all consecutive thoughts
        const thoughts: string[] = [];
        while (i < currentTurnTrace.length && currentTurnTrace[i].type === 'thought') {
          thoughts.push((currentTurnTrace[i] as ThoughtEntry).content);
          i++;
        }
        
        // Check if there's a tool call following
        if (i < currentTurnTrace.length && currentTurnTrace[i].type === 'tool_call') {
          const toolCall = currentTurnTrace[i] as ToolCallEntry;
          const toolCallJson = JSON.stringify({ name: toolCall.toolName, args: toolCall.parameters }, null, 2);
          
          // Format as a complete LLM response
          steps.push(`<scratchpad>
${thoughts.join('\n')}
</scratchpad>

\`\`\`json
${toolCallJson}
\`\`\``);
          
          i++; // Move past the tool call
          
          // Check for tool result
          if (i < currentTurnTrace.length && currentTurnTrace[i].type === 'tool_result') {
            const toolResult = currentTurnTrace[i] as ToolResultEntry;
            const resultJson = toolResult.error 
              ? JSON.stringify({ error: toolResult.error }, null, 2)
              : JSON.stringify(toolResult.result, null, 2);
            steps.push(`→ Tool returned:
\`\`\`json
${resultJson}
\`\`\``);
            i++;
          }
        } else {
          // Just thoughts with no tool call yet
          steps.push(`<scratchpad>
${thoughts.join('\n')}
</scratchpad>`);
        }
      } else {
        // Skip non-thought entries that weren't paired
        i++;
      }
    }
    
    // Format the final output
    const processContent = steps.length > 0 
      ? steps.join('\n\n') + '\n\n***=>>YOU ARE HERE<<=***'
      : '***=>>YOU ARE HERE<<=***';

    return processContent;
  }

  // Get conversation from client
  private async getConversation(): Promise<Conversation> {
    return await this.client.getConversation(this.conversationId, {
      includeTurns: true,
      includeTrace: true
    });
  }

  // Record error trace
  private async recordErrorTrace(error: any): Promise<void> {
    try {
      await this.startTurn();
      await this.addThought(`Error occurred: ${error.message || error}`);
      await this.completeTurn(`I encountered an error and need to stop: ${error.message || error}`);
    } catch (traceError) {
      console.error('Failed to record error trace:', traceError);
    }
  }
}
