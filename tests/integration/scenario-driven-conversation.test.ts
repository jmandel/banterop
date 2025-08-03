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
    `<scratchpad>Starting the authorization process.</scratchpad>\n\`\`\`json\n{"name": "send_message_to_agent_conversation", "args": {"text": "Hello, I'm processing your authorization request."}}\n\`\`\``,
    
    // Turn 2: Look up patient's clinical notes
    `<scratchpad>Let me search for the patient's clinical notes.</scratchpad>\n\`\`\`json\n{"name": "search_ehr_clinical_notes", "args": {"dateRange": "2024-06-01 to 2024-07-01", "searchTerms": "knee injury"}}\n\`\`\``,
    
    // Turn 3: Get therapy documentation
    `<scratchpad>Checking therapy documentation.</scratchpad>\n\`\`\`json\n{"name": "get_therapy_documentation", "args": {"therapyType": "physical therapy", "dateRange": "2024-06-01 to 2024-07-01"}}\n\`\`\``,
    
    // Turn 4: Send update
    `<scratchpad>Providing status update.</scratchpad>\n\`\`\`json\n{"name": "send_message_to_agent_conversation", "args": {"text": "Your authorization is being processed."}}\n\`\`\``,
    
    // Turn 5+: Terminal tool to end conversation
    `<scratchpad>Authorization complete, approving request.</scratchpad>\n\`\`\`json\n{"name": "mri_authorization_Success", "args": {"reason": "Conservative therapy requirements met", "authNumber": "AUTH-123", "validityPeriod": "60 days"}}\n\`\`\``
  ];

  constructor() {
    super({ provider: 'google', apiKey: 'mock-key' });
  }

  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    return this.generateContent(request);
  }

  async generateContent(request: LLMRequest): Promise<LLMResponse> {
    this.lastPrompt = request.messages[0].content;
    
    // Check if this is an Oracle prompt (contains "<YOUR_TASK>")
    if (request.messages[0].content.includes("<YOUR_TASK>")) {
      // This is an Oracle tool synthesis call - return a proper Oracle response
      const oracleResponses: Record<string, any> = {
        "send_message_to_agent_conversation": {
          reasoning: "Creating message turn ID for thread communication.",
          output: "turn-" + Date.now()
        },
        "check_patient_eligibility": {
          reasoning: "Patient is eligible for services under their PPO plan.",
          output: { eligible: true, patientId: "test-123", planType: "PPO" }
        },
        "verify_coverage": {
          reasoning: "MRI is covered with prior authorization requirement.",
          output: { covered: true, requiresPriorAuth: true, copay: "20%" }
        },
        "search_ehr_clinical_notes": {
          reasoning: "Returning clinical notes from the patient's knee injury treatment.",
          output: { notes: "Patient has persistent knee instability after 16 days of conservative therapy." }
        },
        "get_therapy_documentation": {
          reasoning: "Returning PT documentation showing 16 days of conservative therapy.",
          output: { 
            sessions: 12, 
            startDate: "2024-06-15", 
            endDate: "2024-06-27", 
            notes: "Persistent anterior instability with functional activities" 
          }
        },
        "mri_authorization_Success": {
          reasoning: "Authorization approved based on meeting conservative therapy requirements.",
          output: { authNumber: "AUTH-123", status: "approved", validity: "60 days" }
        }
      };
      
      // Extract tool name from the prompt
      const toolNameMatch = request.messages[0].content.match(/<TOOL_NAME>([^<]+)<\/TOOL_NAME>/);
      const toolName = toolNameMatch ? toolNameMatch[1] : "unknown";
      
      const response = oracleResponses[toolName] || {
        reasoning: "Executing the requested tool operation.",
        output: { success: true, message: `Tool ${toolName} executed successfully.` }
      };
      
      return {
        content: `\`\`\`json\n${JSON.stringify(response, null, 2)}\n\`\`\``
      };
    }
    
    // This is a regular agent prompt - return a canned agent response
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

  test('should handle document attachments in conversation flow', async () => {
    console.log('\n--- Starting Attachment Flow Test ---');

    // Create a custom mock LLM that will exercise the attachment flow
    class AttachmentFlowMockLLMProvider extends TerminalAwareMockLLMProvider {
      private attachmentTurnCount: number = 0;
      private attachmentResponses: string[] = [
        // Turn 1: Initial tool call that returns a document reference
        `<scratchpad>Let me look up the medical policy first.</scratchpad>\n\`\`\`json\n{"name": "lookup_medical_policy", "args": {"policyType": "MRI", "bodyPart": "knee"}}\n\`\`\``,
        
        // Turn 2: Resolve the document reference
        `<scratchpad>I need to read the full policy document that was referenced.</scratchpad>\n\`\`\`json\n{"name": "resolve_document_reference", "args": {"refToDocId": "policy_mri_knee_2024", "name": "Knee MRI Policy 2024", "type": "Medical Policy", "contentType": "text/markdown", "summary": "Policy for knee MRI authorization"}}\n\`\`\``,
        
        // Turn 3: Send message with the document attached
        `<scratchpad>Now I'll send the policy document to the patient.</scratchpad>\n\`\`\`json\n{"name": "send_message_to_agent_conversation", "args": {"text": "I've found the relevant medical policy. Please see the attached document for the full requirements.", "attachments_to_include": ["doc_policy_mri_knee_2024"]}}\n\`\`\``,
        
        // Turn 4+: End the conversation
        `<scratchpad>Authorization complete with policy provided.</scratchpad>\n\`\`\`json\n{"name": "mri_authorization_Success", "args": {"reason": "Policy reviewed and requirements met", "authNumber": "AUTH-456"}}\n\`\`\``
      ];

      async generateContent(request: LLMRequest): Promise<LLMResponse> {
        this.lastPrompt = request.messages[0].content;
        await debugLogger.logLLMRequest(request);
        
        const response = this.attachmentTurnCount < this.attachmentResponses.length 
          ? this.attachmentResponses[this.attachmentTurnCount] 
          : this.attachmentResponses[this.attachmentResponses.length - 1];
        this.attachmentTurnCount++;
        
        // Check if terminal tool is being used
        const toolNameMatch = response.match(/"name":\s*"([^"]+)"/);
        if (toolNameMatch) {
          const toolName = toolNameMatch[1];
          if (/Success$|Approval$|Failure$|Denial$|NoSlots$/.test(toolName)) {
            this.terminalToolsUsed.push(toolName);
          }
        }
        
        const llmResponse = { content: response };
        await debugLogger.logLLMResponse(llmResponse);
        return llmResponse;
      }
    }

    // Override the tool synthesis to provide realistic responses
    class AttachmentToolSynthesis extends ToolSynthesisService {
      async execute(input: any) {
        // Handle lookup_medical_policy to return a document reference
        if (input.toolName === 'lookup_medical_policy') {
          return {
            output: {
              policyFound: true,
              policyDetails: {
                refToDocId: 'policy_mri_knee_2024',
                name: 'Knee MRI Policy 2024',
                type: 'Medical Policy',
                contentType: 'text/markdown',
                summary: 'Policy requirements for knee MRI authorization including conservative therapy requirements'
              }
            }
          };
        }
        
        // Handle resolve_document_reference to return full document content
        if (input.toolName === 'resolve_document_reference') {
          return {
            output: {
              docId: 'doc_policy_mri_knee_2024',
              contentType: 'text/markdown',
              content: '# Knee MRI Authorization Policy\n\n## Requirements\n\n1. **Conservative Therapy**: Minimum 14 days of physical therapy\n2. **Documentation**: PT notes must be provided\n3. **Timeline**: Must be within last 60 days\n\n## Approval Criteria\n\n- Evidence of failed conservative treatment\n- Clear medical necessity\n- Appropriate diagnostic pathway'
            }
          };
        }
        
        // Default to parent implementation
        return super.execute(input);
      }
    }

    // Create test setup with attachment-aware mocks
    const attachmentMockLLM = new AttachmentFlowMockLLMProvider();
    const attachmentToolSynthesis = new AttachmentToolSynthesis(attachmentMockLLM);
    
    // Create a new orchestrator with our custom mocks
    const attachmentOrchestrator = new ConversationOrchestrator(
      ':memory:',
      attachmentMockLLM,
      attachmentToolSynthesis
    );
    seedDatabase(attachmentOrchestrator.getDbInstance());

    // Create the conversation
    const kneeMriScenarioId = 'scen_knee_mri_01';
    const createRequest: CreateConversationRequest = {
      name: 'E2E Attachment Test',
      managementMode: 'internal',
      agents: [
        {
          agentId: { id: 'patient-agent', label: 'Patient Agent', role: 'PatientAgent' },
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId,
          messageToUseWhenInitiatingConversation: "I need help getting my knee MRI authorized. Can you provide the policy requirements?"
        } as ScenarioDrivenAgentConfig,
        {
          agentId: { id: 'insurance-auth-specialist', label: 'Insurance Authorization Specialist', role: 'InsuranceAgent' },
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId
        } as ScenarioDrivenAgentConfig
      ],
      initiatingAgentId: 'patient-agent'
    };

    // Set up conversation monitoring
    let conversationEnded = false;
    let attachmentRegistered = false;
    let turnWithAttachments: any = null;
    
    const conversationEndPromise = new Promise<void>((resolve) => {
      attachmentOrchestrator.subscribeToConversation('*', async (event: ConversationEvent) => {
        await debugLogger.logEvent(event.type, event);
        
        if (event.type === 'turn_completed' && event.data.turn.attachments && event.data.turn.attachments.length > 0) {
          attachmentRegistered = true;
          turnWithAttachments = event.data.turn;
        }
        
        if (event.type === 'conversation_ended') {
          conversationEnded = true;
          resolve();
        }
      });
    });

    // Create and start the conversation
    console.log('Creating attachment test conversation...');
    const { conversation } = await attachmentOrchestrator.createConversation(createRequest);
    await attachmentOrchestrator.startConversation(conversation.id);
    console.log(`Conversation ${conversation.id} started.`);

    // Wait for conversation to end
    await Promise.race([
      conversationEndPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Test timeout')), 15000))
    ]);

    // Validate the outcome
    const finalState = attachmentOrchestrator.getConversation(conversation.id, true, true);
    
    // Verify attachment was registered and included in a turn
    expect(attachmentRegistered).toBe(true);
    expect(turnWithAttachments).toBeTruthy();
    expect(turnWithAttachments.attachments).toHaveLength(1);
    
    // Get the attachment details
    const attachmentId = turnWithAttachments.attachments[0];
    const attachment = attachmentOrchestrator.getDbInstance().getAttachment(attachmentId);
    
    expect(attachment).toBeTruthy();
    expect(attachment?.contentType).toBe('text/markdown');
    expect(attachment?.content).toContain('Knee MRI Authorization Policy');
    expect(attachment?.content).toContain('Conservative Therapy');
    
    // Verify the conversation flow included document reference and resolution
    const allTraces = finalState.turns.flatMap(t => t.trace || []);
    
    // Check for lookup_medical_policy tool call
    const lookupCall = allTraces.find(t => t.type === 'tool_call' && (t as any).toolName === 'lookup_medical_policy');
    expect(lookupCall).toBeTruthy();
    
    // Check for resolve_document_reference tool call
    const resolveCall = allTraces.find(t => t.type === 'tool_call' && (t as any).toolName === 'resolve_document_reference');
    expect(resolveCall).toBeTruthy();
    
    // Check that the message with attachment mentioned it
    expect(turnWithAttachments.content).toContain('attached document');
    
    console.log(`Conversation with attachments completed in ${finalState.turns.length} turns.`);
    console.log(`Attachment ID: ${attachmentId}`);
    console.log('--- Attachment Flow Test Passed Successfully ---');

    // Clean up
    attachmentOrchestrator.close();
  }, 20000);
});
