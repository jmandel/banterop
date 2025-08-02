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
  ToolCallEntry
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
  
  private currentTurnId: string;
  private turns: ConversationTurn[] = [];
  private tracesByTurnId: Map<string, TraceEntry[]> = new Map();

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
    // Call parent initialization first
    await super.initialize(conversationId, authToken);
    
    // ONE-TIME-FETCH to hydrate state on startup
    console.log(`Agent ${this.agentId.label} hydrating initial conversation state...`);
    const initialConversation = await this.client.getConversation();
    this.turns = initialConversation.turns || [];

    // Populate the traces map from the initial turns data
    this.tracesByTurnId.clear();
    for (const turn of this.turns) {
        if (turn.trace && turn.trace.length > 0) {
            this.tracesByTurnId.set(turn.id, turn.trace);
        }
    }

    if (initialConversation.metadata.initiatingAgentId === this.agentId.id) {
      console.log("This is the initiating agent", initialConversation.metadata, this)
    }
    else {
      console.log("NOT initiating agent", initialConversation.metadata, this)
    }

    console.log(`Agent ${this.agentId.label} initialized with ${this.turns.length} historical turns.`);
  }

  async onConversationEvent(event: ConversationEvent): Promise<void> {
    if (!this.isReady) return;

    switch (event.type) {
        case 'turn_completed':
            const completedTurn = event.data.turn as ConversationTurn;
            // Add the new turn to our local history
            this.turns.push(completedTurn);
            
            // Trigger the agent's response logic if it's another agent's turn
            if (completedTurn.agentId !== this.agentId.id && !completedTurn.isFinalTurn) {
                await this._processAndRespondToTurn(completedTurn);
            }
            break;

        case 'trace_added':
            const trace = event.data.trace as TraceEntry;
            const turnId = event.data.turn.id; // The turn shell provided in the event
            const existingTraces = this.tracesByTurnId.get(turnId) || [];
            existingTraces.push(trace);
            this.tracesByTurnId.set(turnId, existingTraces);
            break;

        case 'conversation_ended':
            await this.shutdown();
            break;
    }
  }

  onTurnCompleted(event: TurnCompletedEvent): Promise<void> {
      return;
  }

  async initializeConversation(): Promise<void> {
    // For the initiating agent, we start with the configured initial message
    if (this.agentConfig.messageToUseWhenInitiatingConversation) {
      const turnId = await this.startTurn();
      await this.addThought(turnId, "Starting conversation with configured initial message");
      await this.completeTurn(turnId, this.agentConfig.messageToUseWhenInitiatingConversation);
    }
  }

  async processAndReply(previousTurn: ConversationTurn): Promise<void> {
    // This delegates to the existing _processAndRespondToTurn method
    await this._processAndRespondToTurn(previousTurn);
  }


   async _processAndRespondToTurn(triggeringTurn: ConversationTurn): Promise<void> {
    if (this.processingTurn) return; // Prevent concurrent processing
    this.processingTurn = true;

    this.currentTurnId = await this.startTurn()
    const currentTurnTrace: TraceEntry[] = []; // Track traces locally for this turn
    
    let MAX_STEPS = 10;
    let stepCount = 0;
    while (stepCount++ < MAX_STEPS) {
        const historyString = this.buildConversationHistory();
        const currentProcessString = this.formatCurrentProcess(currentTurnTrace);
        
        const prompt = this.constructFullPrompt({
            agentConfig: this.agentConfig,
            tools: this.agentConfig.tools,
            conversationHistory: historyString,
            currentProcess: currentProcessString
        });
        
        // The rest of the agent's logic proceeds from here
        const result = await this.extractToolCallsFromLLMResponse(prompt);
        if (!result.tools || !result.message) {
          console.error("Missing thoughts or tools, ending turn")
          this.completeTurn(this.currentTurnId, "Turn ended with error")
          this.client.endConversation(this.conversationId)
          break;
        }

        console.log("Tools paresed", result)
        const thoughtEntry = await this.addThought(this.currentTurnId, result.message);
        currentTurnTrace.push(thoughtEntry);

        const stepResult = await this.executeSingleToolCallWithReasoning(result, currentTurnTrace);
        if (stepResult.completedTurn) {
          break;
        }
      }
      if (stepCount > MAX_STEPS && this.currentTurnId) {
        console.error("MAX STEPS reaached, bailing")
        try {
          await this.completeTurn(this.currentTurnId, "Error: Max steps reached")
        } catch (error) {
          // Turn might have already been completed by a terminal tool
          console.log("Turn already completed or error completing:", error);
        }
      }

      this.processingTurn = false;
      this.currentTurnId = null;
  }

  private async buildPromptFromState(conversation: any): Promise<string> {
    const interleavedConversation = this.buildInterleavedConversation(conversation.turns || [], conversation.traces || {});
    
    return this.constructFullPrompt({
      agentConfig: this.agentConfig,
      tools: this.agentConfig.tools,
      interleavedConversation
    });
  }

  private buildConversationHistory(): string {
    const sections: string[] = [];
    
    // Process turns chronologically
    for (const turn of this.turns) {
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

  // Build interleaved conversation with turns and their associated tool uses
  private buildInterleavedConversation(turns: ConversationTurn[], traces: Record<string, any>, maxWords: number = 100000): string {
    // First pass: determine which turns we can fit within budget
    const turnData = this.analyzeTurnsForBudget(turns, traces, maxWords);
    
    const sections: string[] = [];
    let skippedCount = 0;
    
    // Add skipped indicator if we're not starting from the beginning
    if (turnData.firstIncludedIndex > 0) {
      skippedCount = turnData.firstIncludedIndex;
      sections.push(`[${skippedCount} conversation turns snipped to save space]`);
    }
    
    // Process included turns with their tool uses
    for (let i = turnData.firstIncludedIndex; i < turns.length; i++) {
      const turn = turns[i];
      if (!turn) continue;
      
      // Add the conversation turn
      sections.push(`[${turn.agentId}] ${turn.content}`);
      
      // Find and add associated tool uses
      const turnTraces = Object.values(traces).filter((trace: any) => 
        trace && trace.turnId === turn.id
      );
      
      for (const trace of turnTraces) {
        const toolUseText = this.formatToolUseForConversation(trace, turnData.toolBudgetPerTurn);
        if (toolUseText) {
          sections.push(toolUseText);
        }
      }
    }
    
    return sections.join('\n\n');
  }

  // Analyze turns to determine what fits within token budget
  private analyzeTurnsForBudget(turns: ConversationTurn[], traces: Record<string, any>, maxWords: number): {
    firstIncludedIndex: number;
    toolBudgetPerTurn: number;
    totalEstimatedWords: number;
  } {
    const turnCosts: Array<{ index: number; baseWords: number; toolWords: number }> = [];
    
    // Calculate cost for each turn including its tool uses
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      if (!turn) continue;
      
      const baseWords = this.countWords(`[${turn.agentId}] ${turn.content}`);
      
      // Calculate tool use words for this turn
      const turnTraces = Object.values(traces).filter((trace: any) => 
        trace && trace.turnId === turn.id
      );
      
      const toolWords = turnTraces.reduce((total, trace) => {
        return total + this.countWords(this.formatTraceForContext(trace));
      }, 0);
      
      turnCosts.push({ index: i, baseWords, toolWords });
    }
    
    // Work backwards to fit as many recent turns as possible
    let totalWords = 0;
    let firstIncludedIndex = turns.length;
    
    for (let i = turnCosts.length - 1; i >= 0; i--) {
      const cost = turnCosts[i];
      const turnTotalWords = cost.baseWords + Math.min(cost.toolWords, 500); // Cap tool words per turn
      
      if (totalWords + turnTotalWords > maxWords && firstIncludedIndex < turns.length) {
        break;
      }
      
      totalWords += turnTotalWords;
      firstIncludedIndex = cost.index;
    }
    
    // Calculate tool budget per turn based on remaining space
    const includedTurns = turns.length - firstIncludedIndex;
    const toolBudgetPerTurn = includedTurns > 0 ? Math.floor((maxWords - totalWords) / includedTurns) + 200 : 500;
    
    return {
      firstIncludedIndex,
      toolBudgetPerTurn: Math.max(toolBudgetPerTurn, 100), // Minimum budget
      totalEstimatedWords: totalWords
    };
  }

  /**
   * Formats the agent's available tools into a structured, readable format.
   */
  private formatTools(tools: Tool[]): string {
    return tools.map(tool => {
      const params = tool.inputSchema?.properties
        ? Object.entries(tool.inputSchema.properties).map(([p, s]: [string, any]) => `${p}: ${s.type}`).join(', ')
        : '';
      const required = tool.inputSchema?.required ? ` (required: ${tool.inputSchema.required.join(', ')})` : '';
      return `- \`${tool.toolName}(${params})\`\n  // ${tool.description}${required}`;
    }).join('\n\n');
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
    interleavedConversation?: string;
  }): string {
    const { agentConfig, tools, conversationHistory, currentProcess, interleavedConversation } = params;

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

</AVAILABLE_TOOLS>`;

    // Use new chronological format if available, otherwise fall back to old format
    let conversationHistorySection: string;
    if (conversationHistory !== undefined) {
      // New chronological format
      conversationHistorySection = `<CONVERSATION_HISTORY>
${conversationHistory}
</CONVERSATION_HISTORY>`;
    } else {
      // Old format for backward compatibility
      conversationHistorySection = `<CONVERSATION_HISTORY>
This is the conversation so far, with the most recent turn first.
${interleavedConversation}

</CONVERSATION_HISTORY>`;
    }

    // Current status section with process details
    const currentStatusSection = currentProcess ? `<CURRENT_STATUS>
You are currently in the middle of processing a turn. Review your progress below.

${currentProcess}

</CURRENT_STATUS>` : '';

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
      temperature: 0.1, // Lower temperature for more deterministic tool use
      maxTokens: 1500
    };

    const response = await this.llmProvider.generateResponse(request);
    console.log("llm response", response)
    const responseContent = response.content;
    return parseToolsFromResponse(responseContent)
  }

  // Execute single tool call with reasoning capture (following single-action constraint)
  private async executeSingleToolCallWithReasoning(result: ParsedResponse, currentTurnTrace: TraceEntry[]): Promise<{completedTurn: boolean}> {
    const { message, tools } = result;
    
    // Handle case where no tool call was made
    if (!tools || tools.length !== 1) {
      console.log(`${this.agentId.id} provided reasoning but no tool call -- ending the turn`);
      return {completedTurn: false};
    }
    const toolCall = tools[0]

    // Handle built-in communication tools
    if (toolCall.name === 'no_response_needed') {
      console.log(`${this.agentId.id} chose not to respond to current situation`);
      this.completeTurn(this.currentTurnId, "No response");
      return {completedTurn: true};
    }

    if (toolCall.name === 'send_message_to_agent_conversation') {
      const { text } = toolCall.args;
      if (!text || typeof text !== 'string' || text.trim() === '') {
        const error = new Error(`${this.agentId.id}: send_message_to_agent_conversation requires non-empty text parameter. Got: ${JSON.stringify(toolCall.args)}`);
        console.error('Stack trace:', error.stack);
        throw error;
      }
      await this.completeTurn(this.currentTurnId, text);
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
      const toolCallEntry = await this.addToolCall(this.currentTurnId, toolCall.name, toolCall.args);
      currentTurnTrace.push(toolCallEntry);
      
      // Query the user and wait for response
      const userResponse = await this.queryUser(text);
      console.log(`${this.agentId.id} received user response: ${userResponse}`);
      
      // Add tool result trace AFTER getting the response
      const toolResultEntry = await this.addToolResult(this.currentTurnId, toolCallEntry.toolCallId, userResponse);
      currentTurnTrace.push(toolResultEntry);
      
      // Turn remains open, agent can continue processing
      return {completedTurn: false};
    }
    
    // Add tool call trace
    const toolCallEntry = await this.addToolCall(this.currentTurnId, toolCall.name, toolCall.args);
    currentTurnTrace.push(toolCallEntry);
    
    try {
      const toolDef = this.getToolDefinition(toolCall.name);
      
      // Build conversation history including the current in-progress turn
      const historyString = this.buildConversationHistory();
      const currentProcessString = this.formatCurrentProcess(currentTurnTrace);
      const fullHistory = historyString + (historyString ? '\n\n' : '') + 
                         `From: ${this.agentId.label} (IN PROGRESS)\n` +
                         `Timestamp: ${new Date().toISOString()}\n\n` +
                         currentProcessString;
      
      const synthesisResult = await this.toolSynthesis.execute({ // New call
          toolName: toolCall.name,
          args: toolCall.args,
          agentId: this.agentId.id,
          scenario: this.scenario,
          conversationHistory: fullHistory
      });

      // The result is already the clean data payload. No parsing needed here.
      const toolOutput = synthesisResult.output;
      
      console.log("Synthesized tool result:", toolOutput);
      const toolResultEntry = await this.addToolResult(this.currentTurnId, toolCallEntry.toolCallId, toolOutput);
      currentTurnTrace.push(toolResultEntry);
      
      if (toolDef?.endsConversation) {
        const resultMessage = `Action complete. Result: ${JSON.stringify(toolOutput)}`;
        await this.completeTurn(this.currentTurnId, resultMessage, true);
        
        console.log(`Terminal tool ${toolCall.name} used, ending conversation gracefully`);
        if (this.conversationId) {
            await this.client.endConversation(this.conversationId);
        }
        return {completedTurn: true}
      } 

      return {completedTurn: false}
    } catch (error: any) {
      // Add error trace
      const errorResultEntry = await this.addToolResult(this.currentTurnId, toolCallEntry.toolCallId, null, error.message);
      currentTurnTrace.push(errorResultEntry);
      
      // Complete turn with error response
      await this.completeTurn(this.currentTurnId, `I encountered an error: ${error.message}`);
      console.error("Error", error)
      console.trace()
      return {completedTurn: true}
    }
  }

  private getToolDefinition(toolName: string): Tool | undefined {
    return this.agentConfig.tools.find(tool => tool.toolName === toolName);
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

  private formatOtherAgentTurn(turn: ConversationTurn): string {
    const timestamp = this.formatTimestamp(turn.timestamp);
    return `From: ${turn.agentId}\nTimestamp: ${timestamp}\n\n${turn.content}\n\n---`;
  }

  private formatOwnTurnForHistory(turn: ConversationTurn): string {
    const timestamp = this.formatTimestamp(turn.timestamp);
    const turnTraces = this.tracesByTurnId.get(turn.id) || [];

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
      const turnId = await this.startTurn();
      await this.addThought(turnId, `Error occurred: ${error.message || error}`);
      await this.completeTurn(turnId, `I encountered an error and need to stop: ${error.message || error}`);
    } catch (traceError) {
      console.error('Failed to record error trace:', traceError);
    }
  }
}
