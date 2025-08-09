import { BaseAgent, type TurnContext } from '$src/agents/runtime/base-agent';
import type { IAgentTransport } from '$src/agents/runtime/runtime.interfaces';
import type { ScenarioConfigAgentDetails, ScenarioConfiguration, Tool } from '$src/types/scenario-configuration.types';
import type { LLMMessage, LLMProvider, LLMRequest } from '$src/types/llm.types';
import type { UnifiedEvent, TracePayload, MessagePayload } from '$src/types/event.types';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';
import type { ScenarioDrivenAgentOptions } from './scenario-driven.types';
import type { LLMProviderManager } from '$src/llm/provider-manager';
import type { SupportedProvider } from '$src/types/llm.types';
import type { AgentMeta } from '$src/types/conversation.meta';
import { ToolSynthesisService } from '$src/agents/services/tool-synthesis.service';
import { logLine } from '$src/lib/utils/logger';
import { ParsedResponse, parseToolsFromResponse } from '$src/lib/utils/tool-parser';

export interface ScenarioDrivenAgentConfig {
  agentId: string;
  providerManager: LLMProviderManager;
  options?: ScenarioDrivenAgentOptions;
}

// Removed unused ToolCall interface

interface TraceEntry {
  type: 'thought' | 'tool_call' | 'tool_result';
  content?: string;
  toolName?: string;
  parameters?: any;
  toolCallId?: string;
  result?: any;
  error?: string;
}

/**
 * Scenario-driven internal agent with full v2 orchestration behavior.
 * - Multi-step loop with MAX_STEPS constraint
 * - Rich XML prompt building with sections
 * - Built-in communication tools
 * - LLM response parsing with scratchpad
 * - Document/attachment handling
 * - Tool synthesis integration
 */
export class ScenarioDrivenAgent extends BaseAgent<ConversationSnapshot> {
  private providerManager: LLMProviderManager;
  private scenario?: ScenarioConfiguration;
  private agentConfig?: ScenarioConfigAgentDetails;
  private llmProvider?: LLMProvider;
  private toolSynthesis?: ToolSynthesisService;
  private processingTurn: boolean = false;
  private availableDocuments: Map<string, any> = new Map();
  private currentTurnTrace: TraceEntry[] = [];
  private MAX_STEPS = 10;

  constructor(
    transport: IAgentTransport,
    cfg: ScenarioDrivenAgentConfig
  ) {
    super(transport);
    this.providerManager = cfg.providerManager;
  }

  protected async takeTurn(ctx: TurnContext<ConversationSnapshot>): Promise<void> {
    const { conversationId, agentId } = ctx;
    
    // Use the snapshot from context (stable view at turn start)
    const snapshot = ctx.snapshot;
    
    console.log(`[${agentId}] takeTurn - runtimeMeta:`, JSON.stringify(snapshot.runtimeMeta, null, 2));
    console.log(`[${agentId}] takeTurn - has scenario:`, !!snapshot.scenario);
    
    if (!snapshot.scenario) {
      // If no scenario, just provide a simple response instead of throwing
      logLine(agentId, 'warn', `No scenario found, using fallback response`);
      await ctx.transport.postMessage({
        conversationId,
        agentId,
        text: 'I understand. How can I assist you?',
        finality: 'turn'
      });
      return;
    }

    this.scenario = snapshot.scenario;
    
    // Find my agent configuration in the scenario
    const myAgent = this.scenario.agents.find(a => a.agentId === agentId);
    if (!myAgent) {
      throw new Error(`Agent ${agentId} not found in scenario configuration`);
    }
    this.agentConfig = myAgent;

    // Add built-in tools to agent config
    const builtInTools = this.getBuiltInTools();
    this.agentConfig.tools = [...builtInTools, ...(this.agentConfig.tools || [])];

    // Get LLM provider - check for agent-specific config first
    this.llmProvider = this.getProviderForAgent(snapshot, agentId);
    this.toolSynthesis = new ToolSynthesisService(this.llmProvider);

    // Clear and rebuild available documents from conversation history
    this.availableDocuments.clear();
    this.extractDocumentsFromHistory(snapshot.events, agentId);

    // Clear current turn trace
    this.currentTurnTrace = [];

    // Process the turn with multi-step loop
    await this._processAndRespondToTurn(ctx);
  }

  private async _processAndRespondToTurn(ctx: TurnContext<ConversationSnapshot>): Promise<void> {
    if (this.processingTurn) return;
    
    this.processingTurn = true;
    let timeToConcludeConversation = false;

    try {
      let stepCount = 0;
      
      while (stepCount++ < this.MAX_STEPS) {
        logLine(ctx.agentId, 'info', `Processing step ${stepCount} of ${this.MAX_STEPS}`);
        
        const historyString = this.buildConversationHistory(ctx.snapshot.events, ctx.agentId);
        const currentProcessString = this.formatCurrentProcess(this.currentTurnTrace);
        
        // Calculate remaining steps
        const remainingSteps = this.MAX_STEPS - stepCount;
        
        const prompt = this.constructFullPrompt({
          agentConfig: this.agentConfig!,
          tools: this.agentConfig!.tools || [],
          conversationHistory: historyString,
          currentProcess: currentProcessString,
          remainingSteps
        });

        logLine(ctx.agentId, 'info', `Prompting LLM with ${prompt.length} characters`);
        
        let result: ParsedResponse;
        try {
          result = await this.extractToolCallsFromLLMResponse(prompt);
          logLine(ctx.agentId, 'info', `LLM response received: ${result.message}`);
        } catch (llmError: any) {
          logLine(ctx.agentId, 'error', `LLM request failed: ${llmError.message}`);
          await this.addThought(ctx, `LLM request failed: ${llmError.message}. I'll try to recover gracefully.`);
          await this.completeTurn(ctx, "I apologize, but I encountered a technical issue. Please try again later.", timeToConcludeConversation);
          break;
        }
        
        // Check if the response had no valid tools due to parsing issues
        if (result.tools.length === 0 && result.message.includes('```json')) {
          await this.addThought(ctx, `My last response was not valid JSON. There may have been a formatting error. I should fix and try again.`);
          continue;
        }
        
        if (!result?.tools?.length) {
          await this.addThought(ctx, "I did not produce a valid tool call JSON block after my scratchpad block. I will try again.");
          continue;
        }

        if (!result.message) {
          await this.addThought(ctx, "I did not provide any reasoning in the <scratchpad> block. I will try again.");
          continue;
        }

        await this.addThought(ctx, result.message);

        const stepResult = await this.executeSingleToolCallWithReasoning(ctx, result, timeToConcludeConversation);
        if (stepResult.completedTurn) {
          break;
        }

        if (timeToConcludeConversation) {
          await this.completeTurn(ctx, "I was supposed to conclude this conversation but I didn't send a message. Ending conversation with error.", true);
          break;
        }

        if (stepResult.isTerminal) {
          timeToConcludeConversation = true;
          logLine(ctx.agentId, 'info', `Reached terminal state, will conclude on next turn`);
        }
      }
      
      // If we exited the loop due to MAX_STEPS and haven't completed the turn
      if (stepCount > this.MAX_STEPS) {
        logLine(ctx.agentId, 'error', "MAX STEPS reached, completing turn with error message");
        try {
          await this.completeTurn(ctx, "Error: Max steps reached without sending a message", timeToConcludeConversation);
        } catch (error: any) {
          logLine(ctx.agentId, 'error', `Failed to complete turn after max steps: ${error.message}`);
          throw error;
        }
      }
    } catch (error: any) {
      logLine(ctx.agentId, 'error', `Error in _processAndRespondToTurn: ${error.message}`);
      try {
        await this.completeTurn(ctx, "I encountered an unexpected error and need to end this turn.", timeToConcludeConversation);
      } catch (completeError: any) {
        logLine(ctx.agentId, 'error', `Failed to complete turn after error: ${completeError.message}`);
        throw completeError;
      }
    } finally {
      this.processingTurn = false;
    }
  }

  private constructFullPrompt(params: {
    agentConfig: ScenarioConfigAgentDetails;
    tools: Tool[];
    conversationHistory?: string;
    currentProcess?: string;
    remainingSteps?: number;
  }): string {
    const { agentConfig, tools, conversationHistory, currentProcess, remainingSteps } = params;

    const separator = '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━';

    // Get scenario metadata from the snapshot
    const scenarioMeta = this.scenario?.metadata;
    const scenarioData = this.scenario?.scenario;
    const scenarioInfo = scenarioMeta 
      ? `\nScenario: ${scenarioMeta.title}\nDescription: ${scenarioMeta.description}\n${scenarioData?.background ? `Background: ${scenarioData.background}\n` : ''}`
      : '';

    const systemPromptSection = `<SYSTEM_PROMPT>
You are an AI agent in a healthcare interoperability scenario.
${scenarioInfo}
Principal: ${agentConfig.principal.name}
└─ ${agentConfig.principal.description}

Role: ${agentConfig.agentId}
Situation: ${agentConfig.situation}

Instructions: ${agentConfig.systemPrompt}

Goals:
${agentConfig.goals.map(g => `• ${g}`).join('\n')}

</SYSTEM_PROMPT>`;
    
    // Knowledge Base Section if present
    let knowledgeBaseSection = '';
    if (agentConfig.knowledgeBase && Object.keys(agentConfig.knowledgeBase).length > 0) {
      knowledgeBaseSection = `
<KNOWLEDGE_BASE>
You have access to the following knowledge:

${Object.entries(agentConfig.knowledgeBase)
  .map(([key, value]) => `${key}: ${typeof value === 'object' ? JSON.stringify(value) : value}`)
  .join('\n')}
</KNOWLEDGE_BASE>`;
    }
    
    // Tools Section with usage guidance
    const toolsSection = `<AVAILABLE_TOOLS>
You have access to the following tools. Each tool must be called with all required parameters.

${this.formatToolsWithGuidance(tools)}

ATTACHMENT GUIDANCE:
- ANY tool response that has a "docId" field at the root level or nested inside is an attachable document. You can attach it directly without any additional resolution. Simple rule: If you see "docId" anywhere in a tool result, that's a document you can attach.
- Tool responses with "refToDocId" (instead of "docId") are references that need to be resolved first using resolve_document_reference.
- To attach documents in your messages:
  1. Collect the docIds from tool results (resolving any refToDocId as needed)
  2. Use send_message_to_agent_conversation with attachments_to_include as an array of docId strings
  Example: attachments_to_include: ["doc_policy_123", "doc_report_456"]
- Never claim "see attached" without including actual attachments.
- Never re-attach a document within the same conversation! Once is plenty.

Never suggest submitting documents through email, portals, or fax; always suggest sharing documents as attachments in the conversation thread.

</AVAILABLE_TOOLS>`;

    let conversationHistorySection: string = `<CONVERSATION_HISTORY>
${conversationHistory || '<!-- No conversation history yet -->'}
</CONVERSATION_HISTORY>`;

    // Current status section with process details
    let currentStatusSection = currentProcess ? `<CURRENT_STATUS>
You are currently in the middle of processing a turn. Review your progress below.

${currentProcess}

</CURRENT_STATUS>` : '';

    // Add warning if approaching MAX_STEPS
    if (remainingSteps === 0) {
      const criticalSection = `
<CRITICAL_FINAL_STEP>
🛑 THIS IS YOUR FINAL STEP - YOU HAVE 0 STEPS REMAINING!
You MUST send a message using send_message_to_agent_conversation NOW.
This is your LAST CHANCE. If you don't send a message, the turn will end with an error.
Do not call any other tools except send_message_to_agent_conversation.
</CRITICAL_FINAL_STEP>`;
      currentStatusSection = criticalSection + currentStatusSection;
    } else if (remainingSteps && remainingSteps <= 3) {
      const warningSection = `
<IMPORTANT_WARNING>
⚠️ You have only ${remainingSteps} step${remainingSteps === 1 ? '' : 's'} remaining in this turn!
You MUST send a message to the conversation thread using send_message_to_agent_conversation before your steps run out.
If you don't send a message before reaching 0 steps, the turn will end with an error.
</IMPORTANT_WARNING>`;
      currentStatusSection = warningSection + currentStatusSection;
    }

    // Response Instructions Section
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
      knowledgeBaseSection,
      knowledgeBaseSection ? separator : '',
      toolsSection,
      separator,
      conversationHistorySection,
      currentStatusSection,
      separator,
      responseInstructionsSection,
      '',
      "🎯 Now, provide your response following the instructions above."
    ].filter(s => s !== null && s !== undefined && s !== '');

    return sections.join('\n\n');
  }

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

  private async extractToolCallsFromLLMResponse(prompt: string): Promise<ParsedResponse> {
    // Split the prompt into system and user parts
    // Everything up to and including AVAILABLE_TOOLS is system prompt
    // Everything after that is user prompt
    const toolsEndIndex = prompt.indexOf('</AVAILABLE_TOOLS>');
    let systemContent = '';
    let userContent = prompt;
    
    if (toolsEndIndex !== -1) {
      const splitPoint = toolsEndIndex + '</AVAILABLE_TOOLS>'.length;
      systemContent = prompt.substring(0, splitPoint).trim();
      userContent = prompt.substring(splitPoint).trim();
    }
    
    const messages: LLMMessage[] = systemContent 
      ? [
          { role: 'system', content: systemContent },
          { role: 'user', content: userContent }
        ]
      : [{ role: 'user', content: prompt }];
    
    const request: LLMRequest = { messages };

    const response = await this.llmProvider!.complete(request);
    
    // Add 100ms delay after LLM generation
    await new Promise(resolve => setTimeout(resolve, 100));
    
    const responseContent = response.content || '';
    return parseToolsFromResponse(responseContent);
  }

  private async executeSingleToolCallWithReasoning(
    ctx: TurnContext<ConversationSnapshot>,
    result: ParsedResponse,
    timeToConcludeConversation = false
  ): Promise<{ completedTurn: boolean; isTerminal?: boolean }> {
    const { tools } = result;
    
    // Handle case where no tool call was made
    if (!tools || tools.length !== 1) {
      return { completedTurn: false };
    }
    const toolCall = tools[0];
    if (!toolCall) {
      return { completedTurn: false };
    }

    // Handle built-in communication tools
    if (toolCall.name === 'no_response_needed') {
      await this.completeTurn(ctx, "No response", timeToConcludeConversation);
      return { completedTurn: true };
    }

    if (toolCall.name === 'send_message_to_agent_conversation') {
      const { text, attachments_to_include } = toolCall.args as any;
      if (!text || typeof text !== 'string' || text.trim() === '') {
        const error = new Error(`send_message_to_agent_conversation requires non-empty text parameter`);
        logLine(ctx.agentId, 'error', error.message);
        throw error;
      }
      
      const attachmentPayloads: any[] = [];
      
      // Process attachments if provided
      if (attachments_to_include && Array.isArray(attachments_to_include) && attachments_to_include.length > 0) {
        const docIds = attachments_to_include.map(item => {
          if (typeof item === 'string') {
            return item;
          } else if (typeof item === 'object' && item.docId) {
            logLine(ctx.agentId, 'warn', `Received object with docId instead of string. Converting...`);
            return item.docId;
          } else {
            logLine(ctx.agentId, 'error', `Invalid attachment format: ${JSON.stringify(item)}`);
            return null;
          }
        }).filter(id => id !== null);
        
        // Filter to keep only valid docIds
        const validDocIds = docIds.filter(docId => this.availableDocuments.has(docId));
        
        if (validDocIds.length < docIds.length) {
          logLine(ctx.agentId, 'warn', `Some docIds were not found. Requested: ${docIds.join(', ')}, Valid: ${validDocIds.join(', ')}`);
        }
        
        // Process each valid docId
        for (const docId of validDocIds) {
          try {
            const doc = this.availableDocuments.get(docId);
            
            if (!doc) {
              logLine(ctx.agentId, 'error', `Could not find document with docId: ${docId}`);
              continue;
            }
            
            // Skip if content is null/undefined/empty
            if (!doc.content) {
              logLine(ctx.agentId, 'warn', `Skipping attachment ${docId} due to missing content`);
              continue;
            }
            
            // Create attachment payload
            const payload = {
              docId: docId,
              name: doc.name || docId,
              contentType: doc.contentType || 'text/markdown',
              content: typeof doc.content === 'string' ? doc.content : JSON.stringify(doc.content),
              summary: doc.summary
            };
            
            attachmentPayloads.push(payload);
          } catch (error: any) {
            logLine(ctx.agentId, 'error', `Failed to process attachment ${docId}: ${error.message}`);
          }
        }
      }
      
      await this.completeTurn(ctx, text, timeToConcludeConversation, attachmentPayloads);
      return { completedTurn: true };
    }

    if (toolCall.name === 'ask_question_to_principal') {
      const { text } = toolCall.args as any;
      if (!text || typeof text !== 'string' || text.trim() === '') {
        const error = new Error(`ask_question_to_principal requires non-empty text parameter`);
        logLine(ctx.agentId, 'error', error.message);
        throw error;
      }
      
      // Add tool call trace
      const toolCallId = await this.addToolCall(ctx, toolCall.name, toolCall.args);
      
      // For v3, we'll simulate the user response since we don't have queryUser
      // In production, this would need to be implemented with actual user interaction
      const userResponse = `[Simulated response from ${this.agentConfig!.principal.name}]: I understand your question "${text}". Please proceed with available information.`;
      
      // Add tool result trace
      await this.addToolResult(ctx, toolCallId, userResponse);
      
      return { completedTurn: false };
    }

    // Handle other tools with synthesis
    const toolCallId = await this.addToolCall(ctx, toolCall.name, toolCall.args);
    
    try {
      const toolDef = this.getToolDefinition(toolCall.name);
      
      let toolOutput: any;
      
      // Special handling for resolve_document_reference
      if (toolCall.name === 'resolve_document_reference' && toolCall.args?.refToDocId) {
        // Check if document already exists
        const existingDoc = this.availableDocuments.get(toolCall.args.refToDocId as string);
        
        if (existingDoc) {
          if (!existingDoc.content) {
            throw new Error(`Document with docId ${toolCall.args.refToDocId} exists but has no content.`);
          }
          toolOutput = {
            docId: existingDoc.docId || toolCall.args.refToDocId,
            name: existingDoc.name,
            contentType: existingDoc.contentType,
            content: existingDoc.content,
            summary: existingDoc.summary
          };
        }
      }
      
      // If we didn't find an existing document, call synthesis
      if (!toolOutput) {
        const historyString = this.buildConversationHistory(ctx.snapshot.events, ctx.agentId);
        const currentProcessString = this.formatCurrentProcess(this.currentTurnTrace);
        const fullHistory = historyString + (historyString ? '\n\n' : '') + 
                           `From: ${ctx.agentId} (IN PROGRESS)\n` +
                           `Timestamp: ${new Date().toISOString()}\n\n` +
                           currentProcessString;
        
        try {
          const synthesisResult = await this.toolSynthesis!.execute({
            tool: {
              toolName: toolDef?.toolName || toolCall.name,
              description: toolDef?.description || '',
              synthesisGuidance: toolDef?.synthesisGuidance || 'Synthesize a reasonable response',
              ...(toolDef?.inputSchema !== undefined ? { inputSchema: toolDef.inputSchema } : {}),
              ...(toolDef?.endsConversation !== undefined ? { endsConversation: toolDef.endsConversation } : {}),
              ...(toolDef?.conversationEndStatus !== undefined ? { conversationEndStatus: toolDef.conversationEndStatus } : {}),
            },
            args: toolCall.args || {},
            agent: {
              agentId: ctx.agentId,
              principal: this.agentConfig!.principal,
              situation: this.agentConfig!.situation,
              systemPrompt: this.agentConfig!.systemPrompt,
              goals: this.agentConfig!.goals,
            },
            scenario: this.scenario!,
            conversationHistory: fullHistory
          });
          
          toolOutput = synthesisResult.output;
        } catch (toolError: any) {
          logLine(ctx.agentId, 'error', `Tool synthesis failed for ${toolCall.name}: ${toolError.message}`);
          toolOutput = {
            error: `Tool execution failed: ${toolError.message}`,
            success: false
          };
          await this.addToolResult(ctx, toolCallId, toolOutput, toolError.message);
          return { completedTurn: false };
        }
      }

      // Reification Logic: Wrap tool output in document structure if it doesn't have a docId
      if (toolOutput && (typeof toolOutput !== 'object' || !toolOutput.hasOwnProperty('docId'))) {
        toolOutput = {
          docId: toolCallId,
          contentType: 'application/json',
          content: toolOutput
        };
      }
      
      // Extract all documents with docIds from the tool output
      const documentsInResult = this.extractDocuments(toolOutput);
      if (documentsInResult.size > 0) {
        for (const [docId, doc] of documentsInResult) {
          this.availableDocuments.set(docId, doc);
        }
      }
      
      await this.addToolResult(ctx, toolCallId, toolOutput);
      
      if (toolDef?.endsConversation) {
        await this.addThought(ctx, 
          `With this final tool result, I'm ready to conclude the conversation. ` +
          `I'll attach this final result's docId via send_message_to_agent_conversation, explaining the outcome.`
        );
        
        return { completedTurn: false, isTerminal: true };
      } 

      return { completedTurn: false };
    } catch (error: any) {
      await this.addToolResult(ctx, toolCallId, null, error.message);
      await this.completeTurn(ctx, `I encountered an error: ${error.message}`, timeToConcludeConversation);
      logLine(ctx.agentId, 'error', `Error: ${error.message}`);
      return { completedTurn: true };
    }
  }

  private buildConversationHistory(events: UnifiedEvent[], myAgentId: string): string {
    const sections: string[] = [];
    
    // Group events by turn
    const turnMap = new Map<number, UnifiedEvent[]>();
    for (const event of events) {
      const turn = event.turn;
      if (!turnMap.has(turn)) {
        turnMap.set(turn, []);
      }
      turnMap.get(turn)!.push(event);
    }
    
    // Process each turn
    for (const [turnId, turnEvents] of turnMap) {
      // Find the main message for this turn
      const message = turnEvents.find(e => e.type === 'message');
      if (!message) continue;
      
      const agentId = message.agentId;
      const timestamp = this.formatTimestamp(message.ts);
      const payload = message.payload as MessagePayload;
      
      if (agentId === myAgentId) {
        // Our own turn - include detailed formatting with traces
        const traces = turnEvents.filter(e => e.type === 'trace');
        sections.push(this.formatOwnTurnForHistory(turnId, agentId, timestamp, payload.text, traces));
      } else {
        // Other agent's turn - simple format
        sections.push(this.formatOtherAgentTurn(agentId, timestamp, payload.text, payload.attachments));
      }
    }
    
    return sections.join('\n\n');
  }

  private formatOwnTurnForHistory(_turnId: number, agentId: string, timestamp: string, content: string, traces: UnifiedEvent[]): string {
    const parts: string[] = [
      `From: ${agentId}`,
      `Timestamp: ${timestamp}`,
      ''
    ];
    
    let currentScratchpad: string[] = [];
    
    // Process traces
    for (const trace of traces) {
      const payload = trace.payload as TracePayload;
      
      if (payload.type === 'thought') {
        currentScratchpad.push(payload.content || '');
      } else if (payload.type === 'tool_call') {
        // Output accumulated thoughts first
        if (currentScratchpad.length > 0) {
          parts.push(`<scratchpad>\n${currentScratchpad.join('\n')}\n</scratchpad>`);
          currentScratchpad = [];
        }
        
        // Output the tool call
        const toolCallJson = JSON.stringify({ name: (payload as any).name, args: (payload as any).args }, null, 2);
        parts.push(`\`\`\`json\n${toolCallJson}\n\`\`\``);
      } else if (payload.type === 'tool_result') {
        // Output the tool result
        const result = (payload as any).result;
        const error = (payload as any).error;
        const resultJson = error ? `{ "error": "${error}" }` : JSON.stringify(result);
        parts.push(`[TOOL_RESULT] ${resultJson}`);
      }
    }
    
    // Output any remaining thoughts
    if (currentScratchpad.length > 0) {
      parts.push(`<scratchpad>\n${currentScratchpad.join('\n')}\n</scratchpad>`);
    }
    
    // Add the final message content
    if (content) {
      parts.push(content);
    }
    
    parts.push('', '---');
    
    return parts.join('\n');
  }

  private formatOtherAgentTurn(agentId: string, timestamp: string, content: string, attachments?: any[]): string {
    let formatted = `From: ${agentId}\nTimestamp: ${timestamp}\n\n${content}`;
    
    // Add attachments if present
    if (attachments && attachments.length > 0) {
      formatted += '\n\n📎 Attachments:';
      for (const attachment of attachments) {
        formatted += `\n• ${attachment.name || 'Untitled Document'} (docId: ${attachment.docId || attachment.id})`;
        if (attachment.summary) {
          formatted += `\n  Summary: ${attachment.summary}`;
        }
        formatted += `\n  💡 Use resolve_document_reference with refToDocId: "${attachment.docId || attachment.id}" to read this document`;
      }
    }
    
    return formatted + '\n\n---';
  }

  private formatCurrentProcess(currentTurnTrace: TraceEntry[]): string {
    // Deduplicate traces before formatting
    const dedupedTraces = this.deduplicateTraces(currentTurnTrace);
    
    if (dedupedTraces.length === 0) {
      return `<!-- No actions taken yet in this turn -->
***=>>YOU ARE HERE<<=***`;
    }

    const steps: string[] = [];
    let i = 0;
    
    while (i < dedupedTraces.length) {
      const trace = dedupedTraces[i];
      if (!trace) continue;
      
      if (trace.type === 'thought') {
        // Collect all consecutive thoughts
        const thoughts: string[] = [];
        while (i < dedupedTraces.length) {
          const currentTrace = dedupedTraces[i];
          if (!currentTrace || currentTrace.type !== 'thought') break;
          thoughts.push(currentTrace.content || '');
          i++;
        }
        
        // Check if there's a tool call following
        if (i < dedupedTraces.length) {
          const nextTrace = dedupedTraces[i];
          if (nextTrace && nextTrace.type === 'tool_call') {
            const toolCall = nextTrace;
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
          if (i < dedupedTraces.length) {
            const resultTrace = dedupedTraces[i];
            if (resultTrace && resultTrace.type === 'tool_result') {
              const toolResult = resultTrace;
              const resultJson = toolResult.error 
                ? JSON.stringify({ error: toolResult.error }, null, 2)
                : JSON.stringify(toolResult.result, null, 2);
              steps.push(`→ Tool returned:
\`\`\`json
${resultJson}
\`\`\``);
              i++;
            }
          }
          } else {
            // Just thoughts with no tool call yet
            steps.push(`<scratchpad>
${thoughts.join('\n')}
</scratchpad>`);
          }
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

  private deduplicateTraces(traces: TraceEntry[]): TraceEntry[] {
    const seen = new Set<string>();
    const deduped: TraceEntry[] = [];
    
    for (const trace of traces) {
      // Create a key for comparison
      let key: string;
      
      if (trace.type === 'thought') {
        key = `thought:${trace.content}`;
      } else if (trace.type === 'tool_call') {
        key = `tool_call:${trace.toolCallId}:${trace.toolName}:${JSON.stringify(trace.parameters)}`;
      } else if (trace.type === 'tool_result') {
        key = `tool_result:${trace.toolCallId}:${JSON.stringify(trace.result)}:${trace.error || ''}`;
      } else {
        key = JSON.stringify(trace);
      }
      
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(trace);
      }
    }
    
    return deduped;
  }

  private formatTimestamp(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toISOString().replace('T', ' ').substring(0, 19);
  }

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

  private extractDocumentsFromHistory(events: UnifiedEvent[], myAgentId: string): void {
    for (const event of events) {
      if (event.type === 'trace' && event.agentId === myAgentId) {
        const payload = event.payload as TracePayload;
        if (payload.type === 'tool_result') {
          const result = (payload as any).result;
          if (result) {
            const documents = this.extractDocuments(result);
            for (const [docId, doc] of documents) {
              this.availableDocuments.set(docId, doc);
            }
          }
        }
      }
    }
  }

  private getToolDefinition(toolName: string): Tool | undefined {
    return this.agentConfig?.tools?.find(tool => tool.toolName === toolName);
  }

  private getBuiltInTools(): Tool[] {
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
      }
    ];
  }

  private async addThought(ctx: TurnContext<ConversationSnapshot>, content: string): Promise<void> {
    this.currentTurnTrace.push({
      type: 'thought',
      content
    });
    
    await ctx.transport.postTrace({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      payload: { type: 'thought', content }
    });
  }

  private async addToolCall(ctx: TurnContext<ConversationSnapshot>, toolName: string, args: any): Promise<string> {
    const toolCallId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    
    this.currentTurnTrace.push({
      type: 'tool_call',
      toolName,
      parameters: args,
      toolCallId
    });
    
    await ctx.transport.postTrace({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      payload: { 
        type: 'tool_call',
        name: toolName,
        args,
        toolCallId
      } as any
    });
    
    return toolCallId;
  }

  private async addToolResult(ctx: TurnContext<ConversationSnapshot>, toolCallId: string, result: any, error?: string): Promise<void> {
    this.currentTurnTrace.push({
      type: 'tool_result',
      toolCallId,
      result,
      ...(error !== undefined ? { error } : {})
    });
    
    await ctx.transport.postTrace({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      payload: { 
        type: 'tool_result',
        toolCallId,
        result,
        ...(error !== undefined ? { error } : {})
      } as any
    });
  }

  private async completeTurn(ctx: TurnContext<ConversationSnapshot>, text: string, concludeConversation: boolean, attachments?: any[]): Promise<void> {
    await ctx.transport.postMessage({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      text,
      finality: concludeConversation ? 'conversation' : 'turn',
      ...(attachments && attachments.length > 0 ? { attachments } : {})
    });
    
    logLine(ctx.agentId, 'info', `ScenarioDrivenAgent(${ctx.agentId}) completed turn`);
  }

  private getProviderForAgent(snapshot: ConversationSnapshot, agentId: string): LLMProvider {
    // Check for runtime agent configuration
    const runtimeAgent = snapshot.runtimeMeta?.agents?.find((a: AgentMeta) => a.id === agentId);
    
    console.log(`[${agentId}] getProviderForAgent - runtimeAgent:`, JSON.stringify(runtimeAgent, null, 2));
    console.log(`[${agentId}] getProviderForAgent - config:`, runtimeAgent?.config);
    
    if (runtimeAgent?.config?.llmProvider) {
      const providerName = runtimeAgent.config.llmProvider as string;
      const model = runtimeAgent.config.model as string | undefined;
      
      console.log(`[${agentId}] Using configured provider: ${providerName}, model: ${model}`);
      
      // For browserside provider, the serverUrl is already configured in the providerManager
      // since it was passed when creating the LLMProviderManager instance
      return this.providerManager.getProvider({ 
        provider: providerName as SupportedProvider,
        ...(model !== undefined ? { model } : {})
      });
    }
    
    console.log(`[${agentId}] Falling back to default provider`);
    // Fall back to system default - this will use browserside with serverUrl if configured
    return this.providerManager.getProvider();
  }
}