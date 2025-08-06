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
      
    let formattedContent = '';
    
    for (const message of request.messages) {
      let content = message.content;
      
      const historyMatch = content.match(/<CONVERSATION_HISTORY>([\s\S]*?)<\/CONVERSATION_HISTORY>/);
      
      if (historyMatch) {
        // Extract system prompt (everything before conversation history)
        const beforeHistory = content.substring(0, content.indexOf('<CONVERSATION_HISTORY>'));
        const conversationHistory = historyMatch[1].trim();
        const afterHistory = content.substring(content.indexOf('</CONVERSATION_HISTORY>') + '</CONVERSATION_HISTORY>'.length);
      
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
      
// 1. MOCK LLM PROVIDER WITH TERMINAL TOOL LOGIC
// =================================================================

/**
 * Simple canned LLM provider for testing.
 * Returns pre-scripted responses that exercise the conversation flow
 * and eventually uses a terminal tool to end the conversation.
 */
class TerminalAwareMockLLMProvider extends LLMProvider {
  public lastPrompt: string = '';
  private agentTurnCounts: Map<string, number> = new Map();
  
  private patientAgentResponses: string[] = [
    `<scratchpad>Let me search for the patient's clinical notes.</scratchpad>\n\`\`\`json\n{"name": "search_ehr_clinical_notes", "args": {"dateRange": "2024-06-01 to 2024-07-01", "searchTerms": "knee injury"}}\n\`\`\``,
    `<scratchpad>Getting therapy documentation.</scratchpad>\n\`\`\`json\n{"name": "get_therapy_documentation", "args": {"therapyType": "physical therapy", "dateRange": "2024-06-01 to 2024-07-01"}}\n\`\`\``,
    `<scratchpad>Sending message to insurance.</scratchpad>\n\`\`\`json\n{"name": "send_message_to_agent_conversation", "args": {"text": "I have completed 16 days of physical therapy as documented."}}\n\`\`\``
  ];
  
  private insuranceAgentResponses: string[] = [
    `<scratchpad>Looking up the medical policy first.</scratchpad>\n\`\`\`json\n{"name": "lookup_medical_policy", "args": {"policyType": "MRI", "bodyPart": "knee"}}\n\`\`\``,
    `<scratchpad>Checking the beneficiary information.</scratchpad>\n\`\`\`json\n{"name": "lookup_beneficiary", "args": {"memberName": "Jordan Alvarez", "dateOfBirth": "1987-09-14"}}\n\`\`\``,
    `<scratchpad>Verifying coverage details.</scratchpad>\n\`\`\`json\n{"name": "check_insurance_coverage", "args": {"memberId": "HF8901234567", "procedureCode": "MRI knee"}}\n\`\`\``,
    `<scratchpad>Creating case notes for documentation.</scratchpad>\n\`\`\`json\n{"name": "create_case_notes", "args": {"caseId": "CASE-123", "notes": "Patient meets conservative therapy requirements.", "policyMet": true}}\n\`\`\``,
    `<scratchpad>Authorization complete, approving request.</scratchpad>\n\`\`\`json\n{"name": "mri_authorization_approval", "args": {"reason": "Conservative therapy requirements met", "authNumber": "AUTH-123", "validityPeriod": "60 days"}}\n\`\`\``
  ];

  constructor() {
    super({ provider: 'google', apiKey: 'mock-key' });
  }

  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    return this.generateContent(request);
  }

  async generateContent(request: LLMRequest): Promise<LLMResponse> {
    this.lastPrompt = request.messages[0].content;
      
    // Check if the prompt contains the terminal tool thought indicating we need to send a final message
    if (request.messages[0].content.includes("With this final tool result, I'm ready to conclude the conversation")) {
      // Return a final send_message_to_agent_conversation response
      const finalResponse = `<scratchpad>The authorization has been completed. I'll send a final message summarizing the outcome.</scratchpad>\n\`\`\`json\n{"name": "send_message_to_agent_conversation", "args": {"text": "The MRI authorization has been approved. Your authorization number is AUTH-123 and it's valid for 60 days. Please proceed with scheduling your MRI."}}\n\`\`\``;
      return { content: finalResponse };
    }
      
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
        "mri_authorization_approval": {
          reasoning: "Authorization approved based on meeting conservative therapy requirements.",
          output: { authNumber: "AUTH-123", status: "approved", validity: "60 days" }
        }
      };
      
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
      
    // Determine which agent is calling based on the prompt content
    let agentId = 'unknown';
    let responses: string[];
    
    // Look for "Role: <agentId>" in the prompt
    const roleMatch = request.messages[0].content.match(/Role:\s*([^\n]+)/);
    if (roleMatch) {
      agentId = roleMatch[1].trim();
    }
    
    if (agentId === 'patient-agent') {
      responses = this.patientAgentResponses;
    } else if (agentId === 'insurance-auth-specialist') {
      responses = this.insuranceAgentResponses;
    } else {
      // Fallback detection
      if (request.messages[0].content.includes('Jordan Alvarez')) {
        agentId = 'patient-agent';
        responses = this.patientAgentResponses;
      } else {
        agentId = 'insurance-auth-specialist';
        responses = this.insuranceAgentResponses;
      }
    }
    
    const turnCount = this.agentTurnCounts.get(agentId) || 0;
    const responseContent = responses[turnCount] || responses[responses.length - 1];
    this.agentTurnCounts.set(agentId, turnCount + 1);
    
    return {
      content: responseContent
    };
  }
  
  getSupportedModels(): string[] {
    return ['mock-model'];
  }
}
      
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
      
    mockLlmProvider = new TerminalAwareMockLLMProvider();
    toolSynthesisService = new ToolSynthesisService(mockLlmProvider);
      
    // This ensures that when the orchestrator creates agents, they receive our mocks
    orchestrator = new ConversationOrchestrator(
      dbPath,
      mockLlmProvider,
      toolSynthesisService
    );
      
    seedDatabase(orchestrator.getDbInstance());
  });

  afterEach(() => {
    orchestrator.close();
  });
      
  // 3. THE TEST CASE
  // =================================================================

  test('should conduct a conversation and terminate when a terminal tool is called', async () => {
    console.log('\n--- Starting Scenario-Driven Agent Conversation Test ---');
      
    // Use the pre-seeded "Knee MRI Prior Auth" scenario
    const kneeMriScenarioId = 'scen_knee_mri_01';
      
    const createRequest: CreateConversationRequest = {
      metadata: { conversationTitle: 'E2E Knee MRI Test' },
      agents: [
        {
          id: "patient-agent",
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId,
          shouldInitiateConversation: true,
          messageToUseWhenInitiatingConversation: "Hello, I'm following up on the prior authorization request for my right knee MRI."
        } as ScenarioDrivenAgentConfig,
        {
          id: "insurance-auth-specialist",
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId
        } as ScenarioDrivenAgentConfig
      ],
      // Use the new property:
    };
      
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
      
    console.log('Creating conversation and provisioning agents...');
    await debugLogger.log('conversation-creation', createRequest);
    
    const { conversation } = await orchestrator.createConversation(createRequest);
    await debugLogger.log('conversation-created', { conversationId: conversation.id, conversation });
      
    await orchestrator.startConversation(conversation.id);
    console.log(`Conversation ${conversation.id} started.`);
    await debugLogger.log('conversation-started', { conversationId: conversation.id });
      
    console.log('Conversation in progress... Waiting for a terminal tool call.');
      
    // The test will timeout if the agents get into an infinite loop.
    await conversationEndPromise;
      
    console.log('Conversation ended. Validating results...');

    const finalState = orchestrator.getConversation(conversation.id, true, true);
    await debugLogger.logConversationState(conversation.id, finalState);
      
    expect(finalState.status).toBe('completed');
    expect(conversationEnded).toBe(true);
      
    // (Initial message + at least one agent response)
    expect(finalState.turns.length).toBeGreaterThan(1); 

    console.log(`Conversation completed in ${finalState.turns.length} turns.`);
      
    // Check that the last turn has isFinalTurn: true
    const lastTurn = finalState.turns[finalState.turns.length - 1];
    expect(lastTurn.isFinalTurn).toBe(true);
    
    // Verify that a tool was called in the last turn
    const lastTurnToolCalls = lastTurn.trace.filter(t => t.type === 'tool_call');
    expect(lastTurnToolCalls.length).toBeGreaterThan(0);
    
    // The fact that isFinalTurn is true means a terminal tool was called
    // We don't need to check tool names, the conversation ended properly
    console.log(`Conversation terminated after ${finalState.turns.length} turns with final turn marked correctly`);

    await debugLogger.log('test-completion', {
      conversationId: conversation.id,
      status: finalState.status,
      turnsCount: finalState.turns.length,
      lastTurnIsFinal: lastTurn.isFinalTurn,
      testPassed: true
    });

    console.log('--- Test Passed Successfully ---');

  }, 15000); // 15-second timeout for the entire test

  test('Knee MRI scenario can be initiated by the supplier agent', async () => {
    console.log('\n--- Starting Supplier-Initiated Conversation Test ---');
      
    const kneeMriScenarioId = 'scen_knee_mri_01';
    
    const createRequest: CreateConversationRequest = {
      metadata: { conversationTitle: 'E2E Knee MRI Test - Supplier Initiated' },
      agents: [
        {
          id: "patient-agent",
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId
        } as ScenarioDrivenAgentConfig,
        {
          id: "insurance-auth-specialist",
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId,
          shouldInitiateConversation: true,
          messageToUseWhenInitiatingConversation: "This is HealthFirst Insurance calling about a prior authorization request for an MRI that needs review."
        } as ScenarioDrivenAgentConfig
      ] // The only change is here
    };
      
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
      
    console.log('Creating supplier-initiated conversation...');
    const { conversation } = await orchestrator.createConversation(createRequest);
    await orchestrator.startConversation(conversation.id);
    console.log(`Conversation ${conversation.id} started with supplier initiation.`);
      
    await Promise.race([
      conversationEndPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Test timeout')), 10000))
    ]);
      
    const finalState = orchestrator.getConversation(conversation.id, true, true);
      
    expect(finalState.turns[0].agentId).toBe('insurance-auth-specialist');
    expect(finalState.turns[0].content).toContain("HealthFirst Insurance calling");
      
    expect(finalState.status).toBe('completed');
    expect(conversationEnded).toBe(true);
    
    console.log(`Supplier-initiated conversation completed in ${finalState.turns.length} turns.`);
    console.log('--- Supplier-Initiated Test Passed Successfully ---');
  }, 15000);

  test('should handle document attachments in conversation flow', async () => {
    console.log('\n--- Starting Attachment Flow Test ---');
      
    class AttachmentFlowMockLLMProvider extends TerminalAwareMockLLMProvider {
      private patientTurnCount: number = 0;
      private insuranceTurnCount: number = 0;
      
      // Patient agent should just respond to messages, not use authorization tools
      private patientResponses: string[] = [
        `<scratchpad>I need to respond to the insurance specialist.</scratchpad>\n\`\`\`json\n{"name": "send_message_to_agent_conversation", "args": {"text": "Thank you for providing the policy document. I've reviewed it and understand the requirements."}}\n\`\`\``
      ];
      
      // Insurance agent has the authorization tools
      private insuranceResponses: string[] = [
        // Turn 1: Initial tool call that returns a document reference
        `<scratchpad>Let me look up the medical policy first.</scratchpad>\n\`\`\`json\n{"name": "lookup_medical_policy", "args": {"policyType": "MRI", "bodyPart": "knee"}}\n\`\`\``,
      
        `<scratchpad>I need to read the full policy document that was referenced.</scratchpad>\n\`\`\`json\n{"name": "resolve_document_reference", "args": {"refToDocId": "policy_mri_knee_2024", "name": "Knee MRI Policy 2024", "type": "Medical Policy", "contentType": "text/markdown", "summary": "Policy for knee MRI authorization"}}\n\`\`\``,
      
        `<scratchpad>Now I'll send the policy document to the patient.</scratchpad>\n\`\`\`json\n{"name": "send_message_to_agent_conversation", "args": {"text": "I've found the relevant medical policy. Please see the attached document for the full requirements.", "attachments_to_include": ["doc_policy_mri_knee_2024"]}}\n\`\`\``,
      
        `<scratchpad>Authorization complete with policy provided.</scratchpad>\n\`\`\`json\n{"name": "mri_authorization_approval", "args": {"reason": "Policy reviewed and requirements met", "authNumber": "AUTH-456"}}\n\`\`\``
      ];

      async generateContent(request: LLMRequest): Promise<LLMResponse> {
        this.lastPrompt = request.messages[0].content;
        await debugLogger.logLLMRequest(request);
        
        // Check if the prompt contains the terminal tool thought indicating we need to send a final message
        if (request.messages[0].content.includes("With this final tool result, I'm ready to conclude the conversation")) {
          // Return a final send_message_to_agent_conversation response
          const finalResponse = `<scratchpad>The authorization has been completed. I'll send a final message with the authorization details.</scratchpad>\n\`\`\`json\n{"name": "send_message_to_agent_conversation", "args": {"text": "Your MRI authorization has been approved. Authorization number AUTH-456 is valid for 60 days. The medical policy document has been provided for your records."}}\n\`\`\``;
          const llmResponse = { content: finalResponse };
          await debugLogger.logLLMResponse(llmResponse);
          return llmResponse;
        }
        
        // Determine which agent is calling based on the prompt content
        let response: string;
        const roleMatch = request.messages[0].content.match(/Role:\s*([^\n]+)/);
        if (roleMatch) {
          const agentId = roleMatch[1].trim();
          
          if (agentId === 'patient-agent') {
            response = this.patientTurnCount < this.patientResponses.length 
              ? this.patientResponses[this.patientTurnCount] 
              : this.patientResponses[this.patientResponses.length - 1];
            this.patientTurnCount++;
          } else {
            response = this.insuranceTurnCount < this.insuranceResponses.length 
              ? this.insuranceResponses[this.insuranceTurnCount] 
              : this.insuranceResponses[this.insuranceResponses.length - 1];
            this.insuranceTurnCount++;
          }
        } else {
          // Fallback to insurance responses if we can't determine the agent
          response = this.insuranceTurnCount < this.insuranceResponses.length 
            ? this.insuranceResponses[this.insuranceTurnCount] 
            : this.insuranceResponses[this.insuranceResponses.length - 1];
          this.insuranceTurnCount++;
        }
      
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
      
        if (input.toolName === 'resolve_document_reference') {
          return {
            output: {
              docId: 'doc_policy_mri_knee_2024',
              contentType: 'text/markdown',
              content: '# Knee MRI Authorization Policy\n\n## Requirements\n\n1. **Conservative Therapy**: Minimum 14 days of physical therapy\n2. **Documentation**: PT notes must be provided\n3. **Timeline**: Must be within last 60 days\n\n## Approval Criteria\n\n- Evidence of failed conservative treatment\n- Clear medical necessity\n- Appropriate diagnostic pathway'
            }
          };
        }
      
        return super.execute(input);
      }
    }
      
    const attachmentMockLLM = new AttachmentFlowMockLLMProvider();
    const attachmentToolSynthesis = new AttachmentToolSynthesis(attachmentMockLLM);
      
    const attachmentOrchestrator = new ConversationOrchestrator(
      ':memory:',
      attachmentMockLLM,
      attachmentToolSynthesis
    );
    seedDatabase(attachmentOrchestrator.getDbInstance());
      
    const kneeMriScenarioId = 'scen_knee_mri_01';
    const createRequest: CreateConversationRequest = {
      metadata: { conversationTitle: 'E2E Attachment Test' },
      agents: [
        {
          id: "patient-agent",
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId,
          shouldInitiateConversation: true,
          messageToUseWhenInitiatingConversation: "I need help getting my knee MRI authorized. Can you provide the policy requirements?"
        } as ScenarioDrivenAgentConfig,
        {
          id: "insurance-auth-specialist",
          strategyType: 'scenario_driven',
          scenarioId: kneeMriScenarioId
        } as ScenarioDrivenAgentConfig
      ]
    };
      
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
      
    console.log('Creating attachment test conversation...');
    const { conversation } = await attachmentOrchestrator.createConversation(createRequest);
    await attachmentOrchestrator.startConversation(conversation.id);
    console.log(`Conversation ${conversation.id} started.`);
      
    await Promise.race([
      conversationEndPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Test timeout')), 15000))
    ]);
      
    const finalState = attachmentOrchestrator.getConversation(conversation.id, true, true);
      
    expect(attachmentRegistered).toBe(true);
    expect(turnWithAttachments).toBeTruthy();
    expect(turnWithAttachments.attachments).toHaveLength(1);
      
    const attachmentId = turnWithAttachments.attachments[0];
    const attachment = attachmentOrchestrator.getDbInstance().getAttachment(attachmentId);
    
    expect(attachment).toBeTruthy();
    expect(attachment?.contentType).toBe('text/markdown');
    expect(attachment?.content).toContain('Knee MRI Authorization Policy');
    expect(attachment?.content).toContain('Conservative Therapy');
      
    const allTraces = finalState.turns.flatMap(t => t.trace || []);
      
    const lookupCall = allTraces.find(t => t.type === 'tool_call' && (t as any).toolName === 'lookup_medical_policy');
    expect(lookupCall).toBeTruthy();
      
    const resolveCall = allTraces.find(t => t.type === 'tool_call' && (t as any).toolName === 'resolve_document_reference');
    expect(resolveCall).toBeTruthy();
      
    expect(turnWithAttachments.content).toContain('attached document');
    
    console.log(`Conversation with attachments completed in ${finalState.turns.length} turns.`);
    console.log(`Attachment ID: ${attachmentId}`);
    console.log('--- Attachment Flow Test Passed Successfully ---');
      
    attachmentOrchestrator.close();
  }, 20000);
});
