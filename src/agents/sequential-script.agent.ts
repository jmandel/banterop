// Sequential Script Agent with Clean Trigger-Based Architecture

import { v4 as uuidv4 } from 'uuid';
import { BaseAgent } from './base.agent.js';
import type { 
  ConversationEvent, TurnStartedEvent, SequentialScriptConfig, 
  SequentialScriptEntry, ScriptStep, ScriptTrigger, ThoughtStep, 
  ToolCallStep, UserQueryStep, ResponseStep, UserQueryAnsweredEvent,
  TurnCompletedEvent, ConversationTurn
} from '$lib/types.js';

/**
 * Sequential Script Agent with Clean Trigger-Based Architecture
 * 
 * Key Features:
 * - Steps execute in order within each script entry
 * - User query responses trigger new script entries (no pausing/resuming)
 * - Supports thoughts, tool calls, user queries, and responses
 * - Each script entry is self-contained and runs to completion
 * - Context matching enables sophisticated conversation flows
 */
export class SequentialScriptAgent extends BaseAgent {
  declare config: SequentialScriptConfig;
  private currentScript?: SequentialScriptEntry;
  private currentStepIndex: number = 0;

  constructor(config: SequentialScriptConfig, client: any) {
    super(config, client);
  }

  /**
   * Handle conversation events and trigger appropriate scripts
   * NO SPECIAL CASES - all events handled uniformly via trigger matching
   */
  async onConversationEvent(event: ConversationEvent): Promise<void> {
    // First check for user_query_answered events which can trigger new scripts
    if (event.type === 'user_query_answered') {
      await this.handleUserQueryAnsweredEvent(event as UserQueryAnsweredEvent);
      return;
    }

    // Handle conversation_ready event
    if (event.type === 'conversation_ready') {
      await this.handleConversationReadyEvent();
      return;
    }

    // Call parent implementation for other events like turn_completed
    await super.onConversationEvent(event);
  }

  async initializeConversation(): Promise<void> {
    // Check for conversation_ready triggers to initiate
    for (const scriptEntry of this.config.script) {
      if (scriptEntry.trigger.type === 'conversation_ready') {
        console.log(`${this.agentId.label} initiating conversation with conversation_ready trigger`);
        await this.executeScript(scriptEntry);
        break;
      }
    }
  }

  async processAndReply(previousTurn: ConversationTurn): Promise<void> {
    // Don't start new scripts while one is running
    if (this.isScriptRunning()) {
      return;
    }

    // Check all script entries for agent_turn trigger matches
    for (const scriptEntry of this.config.script) {
      if (scriptEntry.trigger.type === 'agent_turn') {
        // Create a mock event to check trigger
        const mockEvent: TurnCompletedEvent = {
          type: 'turn_completed',
          conversationId: this.conversationId!,
          timestamp: new Date(),
          data: { turn: previousTurn }
        };
        
        if (this.matchesAgentTurnTrigger(mockEvent, scriptEntry.trigger)) {
          await this.executeScript(scriptEntry);
          break;
        }
      }
    }
  }

  /**
   * Handle turn completed events from other agents (inherited from BaseAgent)
   */  
  async onTurnCompleted(event: TurnCompletedEvent): Promise<void> {
    // Don't start new scripts while one is running
    if (this.isScriptRunning()) {
      return;
    }

    // Check all script entries for agent_turn trigger matches
    for (const scriptEntry of this.config.script) {
      if (scriptEntry.trigger.type === 'agent_turn' && this.matchesAgentTurnTrigger(event, scriptEntry.trigger)) {
        await this.executeScript(scriptEntry);
        break; // Execute only the first matching script
      }
    }
  }

  /**
   * Handle conversation ready events
   */
  private async handleConversationReadyEvent(): Promise<void> {
    // Don't start new scripts while one is running
    if (this.isScriptRunning()) {
      console.log(`${this.agentId.label} ignoring conversation_ready - script already running`);
      return;
    }

    // Check for conversation_ready triggers
    for (const scriptEntry of this.config.script) {
      if (scriptEntry.trigger.type === 'conversation_ready') {
        console.log(`${this.agentId.label} triggered script by: conversation_ready`);
        await this.executeScript(scriptEntry);
        break; // Execute only the first matching script
      }
    }
  }

  /**
   * Handle user query answered events
   */
  private async handleUserQueryAnsweredEvent(event: UserQueryAnsweredEvent): Promise<void> {
    // Don't start new scripts while one is running
    if (this.isScriptRunning()) {
      return;
    }

    // Check all script entries for user_query_answered trigger matches
    for (const scriptEntry of this.config.script) {
      if (scriptEntry.trigger.type === 'user_query_answered' && this.matchesUserQueryAnsweredTrigger(event, scriptEntry.trigger)) {
        await this.executeScript(scriptEntry);
        break; // Execute only the first matching script
      }
    }
  }

  /**
   * Check if an agent turn event matches the trigger
   */
  private matchesAgentTurnTrigger(event: TurnStartedEvent | TurnCompletedEvent, trigger: ScriptTrigger): boolean {
    // Match agent ID if specified
    if (trigger.from && event.data.turn?.agentId !== trigger.from) {
      return false;
    }
    
    // Match content if specified
    if (trigger.contains) {
      const content = event.data.turn?.content || '';
      const regex = new RegExp(trigger.contains, 'i');
      return regex.test(content);
    }
    
    return true;
  }

  /**
   * Check if a user query answered event matches the trigger
   */
  private matchesUserQueryAnsweredTrigger(event: UserQueryAnsweredEvent, trigger: ScriptTrigger): boolean {
    // Match on context if specified - this is the key enhancement
    if (trigger.context && event.data.context) {
      return Object.entries(trigger.context).every(([key, value]) => 
        event.data.context[key] === value
      );
    }
    
    // If no context specified, match any user_query_answered event
    return true;
  }

  /**
   * Execute a script entry from beginning to end
   * Each script entry runs to completion - no pausing/resuming
   */
  private async executeScript(scriptEntry: SequentialScriptEntry): Promise<void> {
    try {
      this.currentScript = scriptEntry;
      this.currentStepIndex = 0;
      
      // Start a new turn for this script execution
      await this.startTurn();
      console.log(`${this.agentId.label} started turn ${this.getCurrentTurnId()} for script execution`);
      
      await this.executeNextStep();
    } catch (error: any) {
      console.error(`${this.agentId.label} error in executeScript:`, error);
      await this.handleScriptError(error);
    }
  }

  /**
   * Execute the next step in the current script
   * This is the core sequencing logic
   */
  private async executeNextStep(): Promise<void> {
    if (!this.currentScript || !this.getCurrentTurnId()) {
      console.warn(`${this.agentId.label} executeNextStep called without active script/turn`);
      return;
    }
    
    const step = this.currentScript.steps[this.currentStepIndex];
    if (!step) {
      // No more steps - complete the script
      await this.completeCurrentScript();
      return;
    }

    console.log(`${this.agentId.label} executing step ${this.currentStepIndex + 1}/${this.currentScript.steps.length}: ${step.type}`);

    try {
      switch (step.type) {
        case 'thought':
          await this.executeThoughtStep(step);
          break;

        case 'tool_call':
          await this.executeToolCallStep(step);
          break;

        case 'user_query':
          await this.executeUserQueryStep(step);
          // User query step completes the script - next steps will be in a different script entry
          await this.completeCurrentScript();
          return;

        case 'response':
          await this.executeResponseStep(step);
          // Response step completes the script and turn
          return;

        default:
          console.warn(`${this.agentId.label} unknown step type: ${(step as any).type}`);
      }

      console.log(`${this.agentId.label} step ${this.currentStepIndex + 1} completed successfully`);

      // Continue to next step
      this.currentStepIndex++;
      console.log(`${this.agentId.label} advancing to step ${this.currentStepIndex + 1}/${this.currentScript.steps.length}`);
      await this.executeNextStep();

    } catch (error: any) {
      console.error(`${this.agentId.label} error executing step:`, error);
      await this.handleScriptError(error);
    }
  }

  /**
   * Execute a thought step - adds trace entry
   */
  private async executeThoughtStep(step: ThoughtStep): Promise<void> {
    await this.addThought(step.content);
  }

  /**
   * Execute a tool call step - adds tool_call and tool_result traces
   */
  private async executeToolCallStep(step: ToolCallStep): Promise<void> {
    // Add tool call trace
    const toolCallId = await this.addToolCall(step.tool.name, step.tool.params);
    
    // No artificial delays for tests
    
    // Add simple tool result trace
    await this.addToolResult(toolCallId, { success: true, tool: step.tool.name });
  }

  /**
   * Execute a user query step - creates query but does NOT pause execution
   * The script completes after creating the query
   * The response will trigger a new script entry via user_query_answered event
   */
  private async executeUserQueryStep(step: UserQueryStep): Promise<void> {
    const queryId = await this.client.createUserQuery(
      step.question,
      step.context || {}
    );
    
    
    // Script execution continues and completes normally
    // No pausing or special state management needed
  }

  /**
   * Execute a response step - completes the turn with final content
   */
  private async executeResponseStep(step: ResponseStep): Promise<void> {
    const turnId = this.getCurrentTurnId();
    console.log(`${this.agentId.label} about to complete turn ${turnId} with content: "${step.content.slice(0, 50)}..."`);
    await this.completeTurn(step.content);
    console.log(`${this.agentId.label} completed turn ${turnId} with response: "${step.content.slice(0, 50)}..."`);
    this.resetScriptState();
  }

  /**
   * Complete current script execution
   * Called when all steps are finished or after user_query step
   */
  private async completeCurrentScript(): Promise<void> {
    if (!this.getCurrentTurnId()) return;
    
    // Check if this script ends with a user_query (incomplete turn)
    const lastStep = this.currentScript!.steps[this.currentScript!.steps.length - 1];
    
    if (lastStep?.type === 'user_query') {
      // Complete the turn with a placeholder message
      await this.completeTurn('Awaiting user response...');
      console.log(`${this.agentId.label} completed turn after user query`);
    } else {
      // Find response step for turn completion, or use default
      const responseStep = this.currentScript!.steps.find(s => s.type === 'response') as ResponseStep;
      const content = responseStep?.content || 'Script execution completed.';
      
      await this.completeTurn(content);
      console.log(`${this.agentId.label} completed script execution and turn`);
    }
    
    this.resetScriptState();
  }

  /**
   * Handle script execution errors
   */
  private async handleScriptError(error: any): Promise<void> {
    console.error(`${this.agentId.label} script error:`, error);
    
    if (this.getCurrentTurnId()) {
      try {
        await this.completeTurn('Script execution failed due to an error.');
      } catch (completionError) {
        console.error(`${this.agentId.label} error completing failed turn:`, completionError);
      }
    }
    
    this.resetScriptState();
  }

  /**
   * Reset agent state after script completion or error
   */
  private resetScriptState(): void {
    this.currentScript = undefined;
    this.currentStepIndex = 0;
  }

  /**
   * Check if a script is currently executing
   */
  private isScriptRunning(): boolean {
    return this.currentScript !== undefined;
  }

  /**
   * Synthesize realistic tool results for testing
   */
  private synthesizeToolResult(tool: { name: string, params: any }): any {
    switch (tool.name) {
      case 'check_customer_account':
        return {
          customer_id: tool.params.customer_id,
          account_status: 'active',
          tier: 'premium',
          recent_issues: ['timeout_errors', 'slow_checkout']
        };

      case 'analyze_database_performance':
        return {
          status: 'degraded',
          avg_response_time: 45000,
          active_connections: 180,
          cpu_usage: 0.85,
          memory_usage: 0.78,
          peak_times: ['09:00-11:00', '14:00-16:00']
        };
        
      case 'run_connection_diagnostics':
        return {
          timeout_count: 23,
          failed_connections: 8,
          pool_utilization: 0.95,
          recommendation: 'increase_pool_size',
          current_pool_size: 10,
          suggested_pool_size: 20
        };
        
      case 'generate_config_template':
        return {
          template_created: true,
          pool_size: tool.params.pool_size || 20,
          timeout_ms: tool.params.timeout || 30000,
          config_file: 'database_pool_config.json',
          estimated_improvement: '60% faster response times'
        };
        
      default:
        return { success: true, executed_at: new Date().toISOString() };
    }
  }

  /**
   * Utility method for realistic delays
   */
  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}