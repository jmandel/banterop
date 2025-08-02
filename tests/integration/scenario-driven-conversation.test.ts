/**
 * E2E Test: Conversation between two ScenarioDrivenAgents
 * 
 * This test validates the end-to-end flow of a conversation between two
 * AI agents driven by a pre-defined scenario. It uses a custom mock LLM
 * to control the conversation flow and ensure termination.
 */

import { test, expect, describe, beforeEach, afterEach } from 'bun:test';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { ToolSynthesisService } from '$agents/services/tool-synthesis.service.js';
import { seedDatabase } from '$backend/db/seed.js';
import { LLMProvider, LLMRequest, LLMResponse } from 'src/types/llm.types.js';
import type { 
  CreateConversationRequest, 
  ConversationEvent, 
  ScenarioDrivenAgentConfig,
  LLMMessage,
  LLMTool,
  LLMToolCall,
  LLMToolResponse
} from '$lib/types.js';
import { mkdir, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

// =================================================================
// DEBUG LOGGING UTILITIES
// =================================================================

const DEBUG_ENV = process.env.DEBUG_SCENARIO_TEST;
const DEBUG_DIR = './debug';

/**
 * Debug logging utility that writes to files when DEBUG_SCENARIO_TEST is set
 */
class DebugLogger {
  private static instance: DebugLogger;
  private debugEnabled: boolean;
  private logCounter: number = 0;
  
  private constructor() {
    this.debugEnabled = !!DEBUG_ENV;
  }
  
  static getInstance(): DebugLogger {
    if (!DebugLogger.instance) {
      DebugLogger.instance = new DebugLogger();
    }
    return DebugLogger.instance;
  }
  
  async ensureDebugDir(): Promise<void> {
    if (!this.debugEnabled) return;
    
    if (!existsSync(DEBUG_DIR)) {
      await mkdir(DEBUG_DIR, { recursive: true });
    }
  }
  
  async log(category: string, data: any): Promise<void> {
    if (!this.debugEnabled) return;
    
    await this.ensureDebugDir();
    
    const timestamp = new Date().toISOString();
    const filename = `${String(this.logCounter++).padStart(3, '0')}-${category}-${timestamp.replace(/[:.]/g, '-')}.json`;
    const filepath = path.join(DEBUG_DIR, filename);
    
    const logEntry = {
      timestamp,
      category,
      data: typeof data === 'string' ? data : JSON.stringify(data, null, 2)
    };
    
    await writeFile(filepath, JSON.stringify(logEntry, null, 2));
    
    if (DEBUG_ENV) {
      console.log(`[DEBUG] Logged ${category} to ${filepath}`);
    }
  }
  
  async logEvent(eventType: string, event: ConversationEvent): Promise<void> {
    await this.log(`event-${eventType}`, event);
  }
  
  async logConversationState(conversationId: string, state: any): Promise<void> {
    await this.log(`conversation-state-${conversationId}`, state);
  }
  
  async logLLMRequest(request: LLMRequest): Promise<void> {
    if (!this.debugEnabled) return;
    
    await this.ensureDebugDir();
    
    // Extract and format the prompt content as clean text
    let formattedContent = '';
    
    for (const message of request.messages) {
      let content = message.content;
      
      // Find the conversation history section and extract parts
      const historyMatch = content.match(/<CONVERSATION_HISTORY>([\s\S]*?)<\/CONVERSATION_HISTORY>/);
      
      if (historyMatch) {
        // Extract system prompt (everything before conversation history)
        const beforeHistory = content.substring(0, content.indexOf('<CONVERSATION_HISTORY>'));
        const conversationHistory = historyMatch[1].trim();
        const afterHistory = content.substring(content.indexOf('</CONVERSATION_HISTORY>') + '</CONVERSATION_HISTORY>'.length);
        
        // Format as clean text
        formattedContent = beforeHistory.trim() + '\n\n---\n\n';
        
        if (conversationHistory) {
          formattedContent += 'CONVERSATION HISTORY:\n' + conversationHistory + '\n\n---\n\n';
        }
        
        formattedContent += afterHistory.trim();
      } else {
        formattedContent = content;
      }
    }
    
    const timestamp = new Date().toISOString();
    const filename = `${String(this.logCounter++).padStart(3, '0')}-llm-request-${timestamp.replace(/[:.]/g, '-')}.txt`;
    const filepath = path.join(DEBUG_DIR, filename);
    
    await writeFile(filepath, formattedContent);
    
    if (DEBUG_ENV) {
      console.log(`[DEBUG] Logged llm-request to ${filepath}`);
    }
  }
  
  async logLLMResponse(response: LLMResponse): Promise<void> {
    await this.log('llm-response', response);
  }
}

// =================================================================
// 1. MOCK LLM PROVIDER WITH TERMINAL TOOL LOGIC
// =================================================================

/**
 * Simple canned LLM provider for testing.
 * Returns pre-scripted responses that exercise the conversation flow
 * and eventually uses a terminal tool to end the conversation.
 */
class TerminalAwareMockLLMProvider extends LLMProvider {
  public lastPrompt: string = '';
  public terminalToolsUsed: string[] = [];
  private turnCount: number = 0;
  private cannedResponses: string[] = [
    // Turn 1: Initial message
    `<scratchpad>Starting the authorization process.</scratchpad>\n\`\`\`json\n{"name": "send_message_to_thread", "args": {"text": "Hello, I'm processing your authorization request."}}\n\`\`\``,
    
    // Turn 2: Check something
    `<scratchpad>Let me verify the patient information.</scratchpad>\n\`\`\`json\n{"name": "check_patient_eligibility", "args": {"patientId": "test-123"}}\n\`\`\``,
    
    // Turn 3: Another check
    `<scratchpad>Checking authorization requirements.</scratchpad>\n\`\`\`json\n{"name": "verify_coverage", "args": {"type": "MRI"}}\n\`\`\``,
    
    // Turn 4: Send update
    `<scratchpad>Providing status update.</scratchpad>\n\`\`\`json\n{"name": "send_message_to_thread", "args": {"text": "Your authorization is being processed."}}\n\`\`\``,
    
    // Turn 5+: Terminal tool to end conversation
    `<scratchpad>Authorization complete, approving request.</scratchpad>\n\`\`\`json\n{"name": "mri_authorization_Success", "args": {"authId": "AUTH-123"}}\n\`\`\``
  ];

  constructor() {
    super({ provider: 'google', apiKey: 'mock-key' });
  }

  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    return this.generateContent(request);
  }

  async generateContent(request: LLMRequest): Promise<LLMResponse> {
    this.lastPrompt = request.messages[0].content;
    
    // Get the canned response for this turn
    const responseContent = this.cannedResponses[this.turnCount] || this.cannedResponses[this.cannedResponses.length - 1];
    
    // Check if this response contains a terminal tool
    const toolMatch = responseContent.match(/"name":\s*"([^"]+)"/);
    if (toolMatch) {
      const toolName = toolMatch[1];
      if (/Success$|Approval$|Failure$|Denial$|NoSlots$/.test(toolName)) {
        this.terminalToolsUsed.push(toolName);
      }
    }
    
    this.turnCount++;
    
    return {
      content: responseContent
    };
  }
  
  getSupportedModels(): string[] {
    return ['mock-model'];
  }
}


// =================================================================
// 2. TEST SUITE SETUP
// =================================================================

describe('Integration Test: Scenario-Driven Agent Conversation', () => {
  let orchestrator: ConversationOrchestrator;
  let mockLlmProvider: TerminalAwareMockLLMProvider;
  let toolSynthesisService: ToolSynthesisService;
  let debugLogger: DebugLogger;

  beforeEach(async () => {
    debugLogger = DebugLogger.getInstance();
    await debugLogger.log('test-setup', 'Starting test setup');
    // Use a fresh in-memory database for each test
    const dbPath = ':memory:';

    // Instantiate our mock components
    mockLlmProvider = new TerminalAwareMockLLMProvider();
    toolSynthesisService = new ToolSynthesisService(mockLlmProvider);

    // Create the orchestrator and inject the mock dependencies
    // This ensures that when the orchestrator creates agents, they receive our mocks
    orchestrator = new ConversationOrchestrator(
      dbPath,
      mockLlmProvider,
      toolSynthesisService
    );

    // Seed the database with the scenarios (e.g., Knee MRI)
    seedDatabase(orchestrator.getDbInstance());
  });

  afterEach(() => {
    orchestrator.close();
  });


  // =================================================================
  // 3. THE TEST CASE
  // =================================================================

  test('should conduct a conversation and terminate when a terminal tool is called', async () => {
    console.log('\n--- Starting Scenario-Driven Agent Conversation Test ---');

    // --- 1. Define the Conversation ---
    // Use the pre-seeded "Knee MRI Prior Auth" scenario
    const kneeMriScenarioId = 'scen_knee_mri_01';
    
    // Define the two scenario-driven agents
    const createRequest: CreateConversationRequest = {
      name: 'E2E Knee MRI Test',
      managementMode: 'internal', // Use internal mode for automatic agent management
      agents: [
        {
          agentId: { id: 'patient-agent', label: 'Patient Agent', role: 'PatientAgent' },
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId,
          messageToUseWhenInitiatingConversation: "Hello, I'm following up on the prior authorization request for my right knee MRI."
        } as ScenarioDrivenAgentConfig,
        {
          agentId: { id: 'insurance-auth-specialist', label: 'Insurance Authorization Specialist', role: 'InsuranceAgent' },
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId
        } as ScenarioDrivenAgentConfig
      ],
      // Use the new property:
      initiatingAgentId: 'patient-agent'
    };

    // --- 2. Set up Conversation Monitoring ---
    let conversationEnded = false;
    const conversationEndPromise = new Promise<void>((resolve) => {
      orchestrator.subscribeToConversation('*', async (event: ConversationEvent) => {
        await debugLogger.logEvent(event.type, event);
        
        if (event.type === 'conversation_ended') {
          conversationEnded = true;
          resolve();
        }
      });
    });

    // --- 2.5. Set up Automated Query Responder ---
    const queryResponses = new Map([
      ['additional documentation', 'Yes, I have uploaded the latest MRI report and physicians notes.'],
      ['any additional', 'I have provided all the necessary documentation for this authorization.'],
      ['do you have', 'Yes, all required documents have been submitted.']
    ]);

    orchestrator.subscribeToConversation('*', async (event: ConversationEvent) => {
      if (event.type === 'user_query_created') {
        const { queryId, question } = event.data;
        const questionLower = question.toLowerCase();
        
        await debugLogger.log('user-query', { queryId, question, questionLower });
        
        for (const [pattern, response] of queryResponses) {
          if (questionLower.includes(pattern)) {
            console.log(`Auto-responding to: "${question}"`);
            console.log(`Response: "${response}"`);
            
            await debugLogger.log('auto-response', { queryId, question, pattern, response });
            
            // Auto-respond after a short delay to simulate user response time
            setTimeout(async () => {
              try {
                await orchestrator.respondToUserQuery(queryId, response);
                await debugLogger.log('response-sent', { queryId, success: true });
              } catch (error) {
                console.error('Error auto-responding to query:', error);
                await debugLogger.log('response-error', { queryId, error: error.message });
              }
            }, 50);
            break;
          }
        }
      }
    });

    // --- 3. Start the Conversation ---
    console.log('Creating conversation and provisioning agents...');
    await debugLogger.log('conversation-creation', createRequest);
    
    const { conversation } = await orchestrator.createConversation(createRequest);
    await debugLogger.log('conversation-created', { conversationId: conversation.id, conversation });
    
    // Start the conversation to activate agents (two-step process)
    await orchestrator.startConversation(conversation.id);
    console.log(`Conversation ${conversation.id} started.`);
    await debugLogger.log('conversation-started', { conversationId: conversation.id });

    // --- 4. Wait for the Conversation to Conclude ---
    console.log('Conversation in progress... Waiting for a terminal tool call.');
    
    // The conversation runs automatically. We just wait for it to end.
    // The test will timeout if the agents get into an infinite loop.
    await conversationEndPromise;
    
    // --- 5. Validate the Outcome ---
    console.log('Conversation ended. Validating results...');

    const finalState = orchestrator.getConversation(conversation.id, true, true);
    await debugLogger.logConversationState(conversation.id, finalState);
    
    // Assertion 1: The conversation status is 'completed'.
    expect(finalState.status).toBe('completed');
    expect(conversationEnded).toBe(true);

    // Assertion 2: The conversation had some back-and-forth.
    // (Initial message + at least one agent response)
    expect(finalState.turns.length).toBeGreaterThan(1); 

    console.log(`Conversation completed in ${finalState.turns.length} turns.`);

    // Assertion 3: A terminal tool was indeed used.
    expect(mockLlmProvider.terminalToolsUsed.length).toBeGreaterThan(0);
    const terminalToolCalled = mockLlmProvider.terminalToolsUsed[0];
    console.log(`Termination caused by tool: ${terminalToolCalled}`);

    // Assertion 4: The last turn's trace contains the terminal tool call.
    const lastTurn = finalState.turns[finalState.turns.length - 1];
    const lastTurnToolCalls = lastTurn.trace.filter(t => t.type === 'tool_call');
    
    expect(lastTurnToolCalls.length).toBeGreaterThan(0);
    const lastToolCallName = (lastTurnToolCalls[0] as any).toolName;
    
    expect(lastToolCallName).toBe(terminalToolCalled);
    console.log(`Verified that the last turn included the call to '${lastToolCallName}'.`);

    await debugLogger.log('test-completion', {
      conversationId: conversation.id,
      status: finalState.status,
      turnsCount: finalState.turns.length,
      terminalToolCalled,
      lastToolCallName,
      testPassed: true
    });

    console.log('--- Test Passed Successfully ---');

  }, 15000); // 15-second timeout for the entire test

  test('Knee MRI scenario can be initiated by the supplier agent', async () => {
    console.log('\n--- Starting Supplier-Initiated Conversation Test ---');

    // Use the same scenario but initiate with the supplier
    const kneeMriScenarioId = 'scen_knee_mri_01';
    
    const createRequest: CreateConversationRequest = {
      name: 'E2E Knee MRI Test - Supplier Initiated',
      managementMode: 'internal',
      agents: [
        {
          agentId: { id: 'patient-agent', label: 'Patient Agent', role: 'PatientAgent' },
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId
        } as ScenarioDrivenAgentConfig,
        {
          agentId: { id: 'insurance-auth-specialist', label: 'Insurance Authorization Specialist', role: 'InsuranceAgent' },
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId,
          messageToUseWhenInitiatingConversation: "This is HealthFirst Insurance calling about a prior authorization request for an MRI that needs review."
        } as ScenarioDrivenAgentConfig
      ],
      initiatingAgentId: 'insurance-auth-specialist' // The only change is here
    };
    
    // Set up conversation monitoring
    let conversationEnded = false;
    const conversationEndPromise = new Promise<void>((resolve) => {
      orchestrator.subscribeToConversation('*', async (event: ConversationEvent) => {
        await debugLogger.logEvent(event.type, event);
        
        if (event.type === 'conversation_ended') {
          conversationEnded = true;
          resolve();
        }
      });
    });

    // Create and start the conversation
    console.log('Creating supplier-initiated conversation...');
    const { conversation } = await orchestrator.createConversation(createRequest);
    await orchestrator.startConversation(conversation.id);
    console.log(`Conversation ${conversation.id} started with supplier initiation.`);

    // Wait for conversation to end (with timeout)
    await Promise.race([
      conversationEndPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Test timeout')), 10000))
    ]);

    // Validate the outcome
    const finalState = orchestrator.getConversation(conversation.id, true, true);
    
    // Check that the first turn was from the insurance-auth-specialist
    expect(finalState.turns[0].agentId).toBe('insurance-auth-specialist');
    expect(finalState.turns[0].content).toContain("HealthFirst Insurance calling");
    
    // Verify conversation completed successfully
    expect(finalState.status).toBe('completed');
    expect(conversationEnded).toBe(true);
    
    console.log(`Supplier-initiated conversation completed in ${finalState.turns.length} turns.`);
    console.log('--- Supplier-Initiated Test Passed Successfully ---');
  }, 15000);
});
