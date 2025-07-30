// Scenario-Driven Agent Implementation

import { BaseAgent } from './base.agent.js';
import { 
  ScenarioConfiguration, TurnAddedEvent, TurnCompletedEvent, 
  TraceEntry, Tool, LLMMessage, LLMRequest, ConversationTurn,
  ScenarioDrivenAgentConfig
} from '$lib/types.js';
import type { OrchestratorClient } from '$client/index.js';
import type { ConversationDatabase } from '$backend/db/database.js';
import { parseToolCalls } from '$lib/utils/tool-parser.js';
import { ToolSynthesisService } from './services/tool-synthesis.service.js';
import type { LLMProvider } from '$llm/types.js';

export class ScenarioDrivenAgent extends BaseAgent {
  private scenario: ScenarioConfiguration;
  private role: 'PatientAgent' | 'SupplierAgent';
  private llmProvider: LLMProvider;
  private toolSynthesis: ToolSynthesisService;
  private processingTurn: boolean = false;
  
  // Local state management for stateful operation
  private turns: ConversationTurn[] = [];
  private tracesByTurnId: Map<string, TraceEntry[]> = new Map();

  constructor(
    config: ScenarioDrivenAgentConfig, 
    client: OrchestratorClient,
    db: ConversationDatabase,
    llmProvider: LLMProvider,
    toolSynthesisService: ToolSynthesisService
  ) {
    super(config, client);
    this.role = config.role;
    this.llmProvider = llmProvider;
    this.toolSynthesis = toolSynthesisService;

    // Agent loads its own context from the database
    const loadedScenario = db.findScenarioByIdAndVersion(config.scenarioId, config.scenarioVersionId);
    if (!loadedScenario) {
      throw new Error(`Agent could not load scenario: ${config.scenarioId}`);
    }
    this.scenario = loadedScenario;

    // Augment scenario tools with built-in communication tools
    const builtInTools = this.getBuiltInTools();
    this.scenario.patientAgent.tools = [...builtInTools, ...this.scenario.patientAgent.tools];
    this.scenario.supplierAgent.tools = [...builtInTools, ...this.scenario.supplierAgent.tools];

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
    const initialConversation = await this.getConversation();
    this.turns = initialConversation.turns || [];

    // Populate the traces map from the initial turns data
    this.tracesByTurnId.clear();
    for (const turn of this.turns) {
        if (turn.trace && turn.trace.length > 0) {
            this.tracesByTurnId.set(turn.id, turn.trace);
        }
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

  async onTurnCompleted(event: TurnCompletedEvent): Promise<void> {
    console.log(`${this.role} onTurnCompleted called - ready: ${this.isReady}, turnId: ${event.data.turn.id}, conversationId: ${this.conversationId}`);
    
    // Don't process if not ready - this should be checked in onConversationEvent but double-check here
    if (!this.isReady) {
      console.log(`${this.role} ignoring turn_completed - not ready yet`);
      return;
    }
    
    // Skip if it's our own turn
    if (event.data.turn.agentId === this.agentId.id) {
      return;
    }

    // Skip if this is a final turn (terminal tool was used)
    if (event.data.turn.isFinalTurn) {
      console.log(`${this.role} skipping final turn processing`);
      return;
    }

    // Add mutex to prevent concurrent processing
    if (this.processingTurn) {
      console.log(`${this.role} already processing turn, skipping this turn_completed event`);
      return;
    }
    
    this.processingTurn = true;
    console.log(`${this.role} starting turn processing for turnId: ${event.data.turn.id}`);

    try {
      // Build full-context prompt with complete conversation and trace history
      const conversation = await this.getConversation();
      const prompt = await this.buildPromptFromState(conversation);
      
      // Get tool calls from LLM using the scenario-based prompt with reasoning
      const result = await this.extractToolCallsFromLLMResponse(prompt);
      
      // Execute single tool call with reasoning (following single-action constraint)
      await this.executeSingleToolCallWithReasoning(result);
      
    } catch (error) {
      console.error(`ScenarioDrivenAgent error for ${this.role}:`, error);
      await this.recordErrorTrace(error);
    } finally {
      this.processingTurn = false;
      console.log(`${this.role} finished processing turn for turnId: ${event.data.turn.id}`);
    }
  }

  private async _processAndRespondToTurn(triggeringTurn: ConversationTurn): Promise<void> {
    if (this.processingTurn) return; // Prevent concurrent processing
    this.processingTurn = true;

    try {
        // This array tracks actions taken within this new turn before the LLM is called.
        const currentTurnTrace: TraceEntry[] = [];

        // OPTIONAL: Any synchronous, pre-LLM actions would be performed here,
        // populating `currentTurnTrace`. For now, it will be empty.

        const historyString = this.buildConversationHistory();
        const currentProcessString = this.formatCurrentProcess(currentTurnTrace);
        
        const prompt = this.constructFullPrompt({
            agentConfig: this.role === 'PatientAgent' ? this.scenario.patientAgent : this.scenario.supplierAgent,
            tools: (this.role === 'PatientAgent' ? this.scenario.patientAgent : this.scenario.supplierAgent).tools,
            conversationHistory: historyString,
            currentProcess: currentProcessString
        });
        
        // The rest of the agent's logic proceeds from here
        const result = await this.extractToolCallsFromLLMResponse(prompt);
        await this.executeSingleToolCallWithReasoning(result);

    } catch (error) {
        console.error(`Error processing turn triggered by ${triggeringTurn.id}:`, error);
    } finally {
        this.processingTurn = false;
    }
  }

  // Build full-context prompt with complete conversation and trace history
  private async buildPromptFromState(conversation: any): Promise<string> {
    const agentConfig = this.role === 'PatientAgent' 
      ? this.scenario.patientAgent 
      : this.scenario.supplierAgent;
    
    const tools = agentConfig.tools;
    
    // Build interleaved conversation with intelligent token management
    const interleavedConversation = this.buildInterleavedConversation(conversation.turns || [], conversation.traces || {});
    
    // Construct the full prompt
    return this.constructFullPrompt({
      agentConfig,
      tools,
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
   * Formats the JSON scenario context into human-readable Markdown.
   */
  private formatScenarioContext(context: any): string {
    if (!context) return "No specific context provided.";
    let md = `**Overview:**\n${context.overview || 'N/A'}\n\n`;
    if (context.timeline) {
      md += `**Relevant Timeline:**\n`;
      md += context.timeline.map((item: any) => `- **${item.date}:** ${item.event}`).join('\n') + '\n\n';
    }
    if (context.clinicalNotes) {
      md += `**Key Clinical Findings:**\n`;
      md += context.clinicalNotes.map((note: string) => `- ${note}`).join('\n');
    }
    return md;
  }

  // Construct the full prompt for the LLM using optimal ordering and XML delimiters
  private constructFullPrompt(params: {
    agentConfig: any;
    tools: Tool[];
    conversationHistory?: string;
    currentProcess?: string;
    interleavedConversation?: string;
  }): string {
    const { agentConfig, tools, conversationHistory, currentProcess, interleavedConversation } = params;
    const scenarioContext = 'clinicalSketch' in agentConfig ? agentConfig.clinicalSketch : agentConfig.operationalContext;

    // 1. System Prompt Section (Who am I?)
    const systemPromptSection = `<SYSTEM_PROMPT>
You are an AI agent in a healthcare interoperability scenario. Your goal is to complete your assigned task by reasoning and using the available tools.
Role: ${this.role}
Principal: ${agentConfig.principalIdentity}
Your Instructions: ${agentConfig.systemPrompt}
</SYSTEM_PROMPT>`;

    // 2. Tools Section (What can I do?)
    const toolsSection = `<TOOLS>
Here are the tools you can use. You must provide all required parameters.
${this.formatTools(tools)}
</TOOLS>`;

    // 3. Scenario Context Section (What is the background?)
    const scenarioContextSection = `<SCENARIO_CONTEXT>
Here is the key background information for this case:
${this.formatScenarioContext(scenarioContext)}
</SCENARIO_CONTEXT>`;

    // Use new chronological format if available, otherwise fall back to old format
    let conversationHistorySection: string;
    if (conversationHistory !== undefined) {
      // New chronological format
      conversationHistorySection = `<CONVERSATION_HISTORY>
${conversationHistory}
---</CONVERSATION_HISTORY>`;
    } else {
      // Old format for backward compatibility
      conversationHistorySection = `<CONVERSATION_HISTORY>
This is the conversation so far, with the most recent turn first.
${interleavedConversation}
</CONVERSATION_HISTORY>`;
    }

    // Current process section (only for new format)
    const currentProcessSection = currentProcess || '';

    // 5. Response Instructions Section (How do I respond?)
    const responseInstructionsSection = `<RESPONSE_INSTRUCTIONS>
Your response MUST follow this EXACT format with no deviation:

<scratchpad>
[Think step-by-step here. Analyze the latest turn in the conversation history, review your context and available tools, and decide on the single best action to take next. Explain your reasoning clearly.]
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

CRITICAL: You MUST include both the <scratchpad> section AND the JSON tool call. Do not add any text before the scratchpad or after the JSON block.
</RESPONSE_INSTRUCTIONS>`;

    // Assemble the final prompt and add a clear call to action.
    const sections = [
      systemPromptSection,
      toolsSection,
      scenarioContextSection,
      conversationHistorySection,
      currentProcessSection, // Placed after history, before instructions
      responseInstructionsSection,
      "Now, provide your response following the instructions above."
    ].filter(s => s); // Remove empty strings

    return sections.join('\n\n');
  }

  // Extract tool calls from LLM response with reasoning capture
  private async extractToolCallsFromLLMResponse(prompt: string): Promise<{ reasoning: string; toolCall: any | null }> {
    const messages: LLMMessage[] = [{ role: 'user', content: prompt }];
    const request: LLMRequest = {
      messages,
      temperature: 0.1, // Lower temperature for more deterministic tool use
      maxTokens: 1500
    };

    const response = await this.llmProvider.generateContent(request);
    const responseContent = response.content;

    // Use regex to robustly extract content from within the tags
    const scratchpadRegex = /<scratchpad>([\s\S]*?)<\/scratchpad>/;
    const jsonRegex = /```json\s*([\s\S]*?)\s*```/;

    const reasoningMatch = responseContent.match(scratchpadRegex);
    const toolCallMatch = responseContent.match(jsonRegex);

    // Extract reasoning: prefer scratchpad, fall back to content before JSON block for backward compatibility
    let reasoning: string;
    if (reasoningMatch) {
      reasoning = reasoningMatch[1].trim();
    } else {
      // Fallback: extract everything before the first JSON block
      const contentBeforeJson = responseContent.split('```')[0]?.trim() || '';
      reasoning = contentBeforeJson || 'Agent provided response without clear reasoning structure.';
    }
    
    let toolCall = null;

    if (toolCallMatch && toolCallMatch[1]) {
      try {
        const parsedJson = JSON.parse(toolCallMatch[1]);
        // Adhere to the instructed { "name": ..., "args": ... } structure
        toolCall = {
          tool: parsedJson.name,
          parameters: parsedJson.args || {} // Default to empty object if args are missing
        };
      } catch (e) {
        console.error("Failed to parse tool call JSON from LLM response", e);
        // The agent will proceed without a tool call if parsing fails.
      }
    }

    if (!toolCall && reasoning) {
      console.log("No valid tool call found, but reasoning was present. Defaulting to no_response_needed.");
      return {
        reasoning,
        toolCall: { tool: 'no_response_needed', parameters: {} }
      };
    }

    return { reasoning, toolCall };
  }

  // Execute single tool call with reasoning capture (following single-action constraint)
  private async executeSingleToolCallWithReasoning(result: { reasoning: string; toolCall: any | null }): Promise<void> {
    const { reasoning, toolCall } = result;
    
    // Handle case where no tool call was made
    if (!toolCall) {
      console.log(`${this.role} provided reasoning but no tool call - treating as no_response_needed`);
      return;
    }

    // Handle built-in communication tools
    if (toolCall.tool === 'no_response_needed') {
      console.log(`${this.role} chose not to respond to current situation`);
      return;
    }

    if (toolCall.tool === 'send_message_to_thread') {
      const { text } = toolCall.parameters;
      if (!text || typeof text !== 'string' || text.trim() === '') {
        const error = new Error(`${this.role}: send_message_to_thread requires non-empty text parameter. Got: ${JSON.stringify(toolCall.parameters)}`);
        console.error('Stack trace:', error.stack);
        throw error;
      }
      const turnId = await this.startTurn();
      await this.addThought(turnId, reasoning);
      await this.completeTurn(turnId, text);
      return;
    }

    if (toolCall.tool === 'send_message_to_principal') {
      const { text } = toolCall.parameters;
      if (!text || typeof text !== 'string' || text.trim() === '') {
        const error = new Error(`${this.role}: send_message_to_principal requires non-empty text parameter. Got: ${JSON.stringify(toolCall.parameters)}`);
        console.error('Stack trace:', error.stack);
        throw error;
      }
      const queryId = await this.client.createUserQuery(text);
      console.log(`${this.role} created user query: ${queryId}`);
      // Turn remains open, waiting for user response
      return;
    }
    
    // Start a turn for streaming execution
    const turnId = await this.startTurn();
    
    // Add reasoning as initial thought trace
    await this.addThought(turnId, reasoning);
    
    // Add tool execution thought
    await this.addThought(turnId, `Executing ${toolCall.tool} with parameters: ${JSON.stringify(toolCall.parameters)}`);
    
    // Add tool call trace
    const toolCallId = await this.addToolCall(turnId, toolCall.tool, toolCall.parameters);
    
    try {
      // Execute the tool using synthesis service
      const synthesisResult = await this.toolSynthesis.synthesizeToolResult(
        toolCall.tool,
        toolCall.parameters,
        this.getToolDefinition(toolCall.tool)
      );
      
      // Add tool result trace
      await this.addToolResult(turnId, toolCallId, synthesisResult);
      
      // If this was a terminal tool, announce result and mark as final turn
      if (this.isTerminalTool(toolCall.tool)) {
        // First, announce the terminal result to other agents
        const resultMessage = `Authorization ${toolCall.tool.includes('Success') ? 'approved' : 'denied'}: ${JSON.stringify(synthesisResult)}`;
        await this.completeTurn(turnId, resultMessage, true);
        
        console.log(`Terminal tool ${toolCall.tool} used, ending conversation gracefully`);
        // End conversation after announcing the result
        await this.client.endConversation(this.conversationId);
      } else {
        // Generate final response based on tool result for non-terminal tools
        const responseContent = this.formatToolResponse(toolCall.tool, synthesisResult);
        
        // Complete the turn
        await this.completeTurn(turnId, responseContent);
      }
      
    } catch (error: any) {
      // Add error trace
      await this.addToolResult(turnId, toolCallId, null, error.message);
      
      // Complete turn with error response
      await this.completeTurn(turnId, `I encountered an error: ${error.message}`);
    }
  }

  // Get tool definition from scenario configuration
  private getToolDefinition(toolName: string): Tool | undefined {
    const agentConfig = this.role === 'PatientAgent' 
      ? this.scenario.patientAgent 
      : this.scenario.supplierAgent;
    
    return agentConfig.tools.find(tool => tool.toolName === toolName);
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

  // Check if a tool is terminal (ends the conversation)
  private isTerminalTool(toolName: string): boolean {
    const terminalSuffixes = ['Success', 'Approval', 'Failure', 'Denial', 'NoSlots'];
    return terminalSuffixes.some(suffix => toolName.endsWith(suffix));
  }

  // Get built-in communication tools (copied from AgentRuntime)
  private getBuiltInTools(): Tool[] {
    return [
      {
        toolName: 'send_message_to_thread',
        description: 'Post a message to the conversation thread for other agents to see',
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1 },
            audience: { 
              oneOf: [
                { type: 'string', enum: ['all'] },
                { type: 'array', items: { type: 'string' } }
              ]
            }
          }
        },
        outputDescription: 'Confirmation that message was posted to thread',
        synthesisGuidance: 'Return the turn ID of the created message'
      },
      {
        toolName: 'send_message_to_principal',
        description: 'Send a message or question to the human principal this agent represents',
        inputSchema: {
          type: 'object',
          required: ['text'],
          properties: {
            text: { type: 'string', minLength: 1 },
            uiSchema: { type: 'object' },
            expectReply: { type: 'boolean' }
          }
        },
        outputDescription: 'Confirmation that principal was prompted',
        synthesisGuidance: 'Return the turn ID of the user_query that was created'
      },
      {
        toolName: 'no_response_needed',
        description: 'Use this when no action or response is needed in the current situation',
        inputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: false
        },
        outputDescription: 'Acknowledgment that no response was needed',
        synthesisGuidance: 'Agent chose not to respond to the current situation'
      }
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
  private formatTraceForContext(trace: any): string {
    if (!trace.steps) return '';
    
    const steps = trace.steps.map((step: any) => {
      switch (step.type) {
        case 'thought':
          return `THOUGHT: ${step.label}${step.detail ? ' - ' + step.detail : ''}`;
        case 'tool_call':
          return `TOOL_CALL: ${step.label}${step.data ? ' - ' + JSON.stringify(step.data) : ''}`;
        case 'tool_result':
          return `TOOL_RESULT: ${step.label}${step.data ? ' - ' + JSON.stringify(step.data) : ''}`;
        case 'synthesis':
          // Synthesis is internal - don't show to agent, it just sees the tool result
          return '';
        default:
          return `${(step.type as string).toUpperCase()}: ${step.label}`;
      }
    }).filter(step => step).join(' → '); // Filter out empty synthesis steps
    
    return `TRACE [${trace.id || 'unknown'}]: ${steps}`;
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
    return `[${timestamp}] [${turn.agentId}]\n${turn.content}`;
  }

  private formatOwnTurnForHistory(turn: ConversationTurn): string {
    const timestamp = this.formatTimestamp(turn.timestamp);
    const turnTraces = this.tracesByTurnId.get(turn.id) || [];

    const thoughts = turnTraces
        .filter(e => e.type === 'thought')
        .map(e => (e as any).content)
        .join('\n');
    const scratchpadBlock = `<scratchpad>\n${thoughts || 'No thoughts recorded.'}\n</scratchpad>`;

    const toolCall = turnTraces.find(e => e.type === 'tool_call') as ToolCallEntry | undefined;
    let toolCallBlock = '';
    let toolResultBlock = '';

    if (toolCall) {
        const toolCallJson = JSON.stringify({ name: toolCall.toolName, args: toolCall.parameters }, null, 2);
        toolCallBlock = `\`\`\`json\n${toolCallJson}\n\`\`\``;

        const toolResult = turnTraces.find(e => e.type === 'tool_result' && (e as any).toolCallId === toolCall.toolCallId) as ToolResultEntry | undefined;
        if (toolResult) {
            const resultJson = toolResult.error ? `{ "error": "${toolResult.error}" }` : JSON.stringify(toolResult.result);
            toolResultBlock = `[TOOL_RESULT] ${resultJson}`;
        }
    }

    const parts = [
        `[${timestamp}] [${this.agentId.label}]`,
        scratchpadBlock,
        toolCallBlock,
        toolResultBlock,
        turn.content
    ];

    return parts.filter(Boolean).join('\n');
  }

  private formatCurrentProcess(currentTurnTrace: TraceEntry[]): string {
    if (currentTurnTrace.length === 0) {
        return `<ourCurrentProcess>\n  <!-- No actions taken yet in this turn -->\n  ***=>>YOU ARE HERE<<=***\n</ourCurrentProcess>`;
    }

    const thoughts = currentTurnTrace
        .filter(e => e.type === 'thought')
        .map(e => (e as any).content)
        .join('\n');
    const scratchpadBlock = `<scratchpad>\n${thoughts}\n</scratchpad>`;
    
    const toolCall = currentTurnTrace.find(e => e.type === 'tool_call') as ToolCallEntry | undefined;
    let toolCallBlock = '';
    let toolResultBlock = '';

    if (toolCall) {
        const toolCallJson = JSON.stringify({ name: toolCall.toolName, args: toolCall.parameters }, null, 2);
        toolCallBlock = `\`\`\`json\n${toolCallJson}\n\`\`\``;

        const toolResult = currentTurnTrace.find(e => e.type === 'tool_result' && (e as any).toolCallId === toolCall.toolCallId) as ToolResultEntry | undefined;
        if (toolResult) {
            const resultJson = toolResult.error ? `{ "error": "${toolResult.error}" }` : JSON.stringify(toolResult.result);
            toolResultBlock = `[TOOL_RESULT] ${resultJson}`;
        }
    }

    const parts = [scratchpadBlock, toolCallBlock, toolResultBlock, '***=>>YOU ARE HERE<<=***'];
    return `<ourCurrentProcess>\n${parts.filter(Boolean).join('\n')}\n</ourCurrentProcess>`;
  }

  // Get conversation from client
  private async getConversation(): Promise<any> {
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
