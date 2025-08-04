import { describe, it, expect, beforeEach } from 'bun:test';
import { createAgent } from '$agents/factory.js';
import { ToolSynthesisService } from '$agents/services/tool-synthesis.service.js';
import type { 
  ScenarioDrivenAgentConfig, ScenarioConfiguration,
  LLMRequest, LLMResponse, AgentInterface
} from '$lib/types.js';
import { LLMProvider } from '$lib/types.js';
import type { OrchestratorClient } from '$client/index.js';
import { v4 as uuidv4 } from 'uuid';
import { ConversationDatabase } from '$backend/db/database.js';

// Mock implementations
class MockOrchestratorClient implements Partial<OrchestratorClient> {
  conversationId = 'test-conversation';
  completeTurnCalls: any[] = [];
  thoughtsCaptured: string[] = [];
  currentTurnId: string | null = null;
  conversationEnded = false;
  
  on(event: string, handler: any): OrchestratorClient { return this as any; }
  async startTurn() { 
    this.currentTurnId = uuidv4();
    return this.currentTurnId; 
  }
  async addTrace(turnId: string, trace: any) { 
    if (trace.type === 'thought') {
      this.thoughtsCaptured.push(trace.content);
    }
    return trace; 
  }
  async addThought(turnId: string, content: string) { 
    this.thoughtsCaptured.push(content);
    return { id: uuidv4(), type: 'thought', content, agentId: 'test', timestamp: new Date() } as any;
  }
  async addToolCall(turnId: string, toolName: string, parameters: any) {
    return { 
      id: uuidv4(), 
      type: 'tool_call', 
      toolName, 
      parameters, 
      toolCallId: uuidv4(),
      agentId: 'test',
      timestamp: new Date() 
    } as any;
  }
  async addToolResult(turnId: string, toolCallId: string, result: any, error?: string) {
    return { 
      id: uuidv4(), 
      type: 'tool_result', 
      toolCallId, 
      result, 
      error,
      agentId: 'test',
      timestamp: new Date() 
    } as any;
  }
  async completeTurn(turnId: string, content: string, isFinalTurn?: boolean, metadata?: any, attachments?: any[]) {
    this.completeTurnCalls.push({ turnId, content, isFinalTurn, metadata, attachments });
    this.currentTurnId = null;
    return { id: turnId, content, attachments: [] } as any;
  }
  async getConversation() {
    return { turns: [], metadata: {} } as any;
  }
  async endConversation(conversationId: string) {
    this.conversationEnded = true;
  }
  async getAttachment(attachmentId: string) {
    return null;
  }
  async getAttachmentByDocId(conversationId: string, docId: string) {
    return null;
  }
}

class FailingLLMProvider extends LLMProvider {
  private failureMessage: string;
  
  constructor(failureMessage: string = 'Simulated LLM failure') {
    super({ provider: 'google' as any, apiKey: 'test-key' });
    this.failureMessage = failureMessage;
  }

  async generateContent(request: any): Promise<any> {
    throw new Error(this.failureMessage);
  }
  
  async generateResponse(request: any): Promise<any> {
    return this.generateContent(request);
  }

  validateRequest(request: any): void {}
  formatResponse(response: any): any { return response; }
  getSupportedModels(): string[] { return ['test-model']; }
}

class MockLLMProvider extends LLMProvider {
  private responses: string[] = [];
  private responseIndex = 0;

  constructor() {
    super({ provider: 'google' as any, apiKey: 'test-key' });
  }

  setResponses(responses: string[]) {
    this.responses = responses;
    this.responseIndex = 0;
  }

  async generateContent(request: any): Promise<any> {
    const response = this.responses[this.responseIndex++] || 'No response';
    return {
      content: response,
      usage: { promptTokens: 10, completionTokens: 20 }
    };
  }
  
  async generateResponse(request: any): Promise<any> {
    return this.generateContent(request);
  }

  validateRequest(request: any): void {}
  formatResponse(response: any): any { return response; }
  getSupportedModels(): string[] { return ['test-model']; }
}

class FailingToolSynthesis extends ToolSynthesisService {
  private shouldFail: boolean = false;
  
  setShouldFail(shouldFail: boolean) {
    this.shouldFail = shouldFail;
  }

  async execute(input: any): Promise<any> {
    if (this.shouldFail) {
      throw new Error('Tool synthesis failed');
    }
    return { output: { success: true } };
  }
}

// Test suite
describe('LLM Error Handling', () => {
  let mockClient: MockOrchestratorClient;
  let failingLLM: FailingLLMProvider;
  let failingToolSynthesis: FailingToolSynthesis;
  let agent: AgentInterface;
  let scenario: ScenarioConfiguration;
  let mockDb: ConversationDatabase;

  beforeEach(() => {
    mockClient = new MockOrchestratorClient();
    failingLLM = new FailingLLMProvider('Network error: 500 Internal Server Error');
    failingToolSynthesis = new FailingToolSynthesis(failingLLM);
    
    scenario = {
      id: 'test-scenario',
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'test' },
        llmEndpoint: { provider: 'test', model: 'test' },
        principal: {
          name: 'Test Principal',
          terminologySystem: 'test-system'
        },
        situation: 'Test situation',
        systemPrompt: 'Test system prompt',
        goals: ['Test goal 1', 'Test goal 2'],
        tools: [
          {
            name: 'send_message_to_agent_conversation',
            description: 'Send a message',
            parameters: {}
          }
        ]
      }],
      patientAgent: {
        id: 'patient',
        llmEndpoint: { provider: 'test', model: 'test' },
        tools: []
      },
      supplierAgent: {
        id: 'supplier',
        llmEndpoint: { provider: 'test', model: 'test' },
        tools: []
      },
      tools: []
    } as any;
    
    const config: ScenarioDrivenAgentConfig = {
      agentId: { id: 'test-agent', label: 'Test Agent', role: 'test' },
      strategyType: 'scenario_driven',
      scenarioId: 'test-scenario'
    };
    
    mockDb = new ConversationDatabase(':memory:');
    
    agent = createAgent(
      config,
      mockClient as any,
      {
        db: mockDb,
        llmProvider: failingLLM,
        toolSynthesisService: failingToolSynthesis,
        scenario: scenario
      }
    );
  });

  describe('LLM Request Failures', () => {
    it('should handle LLM failures gracefully without crashing', async () => {
      // Trigger the agent to process a turn
      const mockTurn = {
        id: 'test-turn',
        conversationId: 'test-conversation',
        agentId: 'other-agent',
        content: 'Hello, can you help me?',
        timestamp: new Date(),
        status: 'completed' as const
      };
      
      // Process should not throw
      await expect((agent as any).processAndReply(mockTurn)).resolves.toBeUndefined();
      
      // Verify the agent completed a turn with an error message
      expect(mockClient.completeTurnCalls).toHaveLength(1);
      const completedTurnContent = mockClient.completeTurnCalls[0].content;
      // The error handler uses either "technical issue" or "unexpected error" messages
      expect(
        completedTurnContent.includes('technical issue') || 
        completedTurnContent.includes('unexpected error')
      ).toBe(true);
      
      // Verify thought was captured about the error
      const errorThoughts = mockClient.thoughtsCaptured.filter(t => 
        t.includes('LLM request failed')
      );
      expect(errorThoughts).toHaveLength(1);
      expect(errorThoughts[0]).toContain('Network error: 500 Internal Server Error');
      
      // Verify conversation was not ended
      expect(mockClient.conversationEnded).toBe(false);
    });

    it('should handle different types of LLM errors', async () => {
      const errors = [
        'Connection refused',
        'API key invalid',
        'Rate limit exceeded',
        'Model not found'
      ];
      
      for (const errorMsg of errors) {
        mockClient = new MockOrchestratorClient();
        failingLLM = new FailingLLMProvider(errorMsg);
        
        agent = createAgent(
          {
            agentId: { id: 'test-agent', label: 'Test Agent', role: 'test' },
            strategyType: 'scenario_driven',
            scenarioId: 'test-scenario'
          },
          mockClient as any,
          {
            db: mockDb,
            llmProvider: failingLLM,
            toolSynthesisService: failingToolSynthesis,
            scenario: scenario
          }
        );
        
        const mockTurn = {
          id: `test-turn-${errorMsg}`,
          conversationId: 'test-conversation',
          agentId: 'other-agent',
          content: 'Test message',
          timestamp: new Date(),
          status: 'completed' as const
        };
        
        await expect((agent as any).processAndReply(mockTurn)).resolves.toBeUndefined();
        
        // Verify graceful handling
        expect(mockClient.completeTurnCalls).toHaveLength(1);
        expect(mockClient.thoughtsCaptured.some(t => t.includes(errorMsg))).toBe(true);
      }
    });
  });

  describe('Tool Synthesis Failures', () => {
    it('should handle tool synthesis failures gracefully', async () => {
      // Use a working LLM but failing tool synthesis
      const workingLLM = new MockLLMProvider();
      workingLLM.setResponses([`<scratchpad>
        I'll look up the patient.
        </scratchpad>
        
        \`\`\`json
        {
          "name": "lookup_patient",
          "args": {
            "name": "John Smith"
          }
        }
        \`\`\``]);
      
      agent = createAgent(
        {
          agentId: { id: 'test-agent', label: 'Test Agent', role: 'test' },
          strategyType: 'scenario_driven',
          scenarioId: 'test-scenario'
        },
        mockClient as any,
        {
          db: mockDb,
          llmProvider: workingLLM,
          toolSynthesisService: failingToolSynthesis,
          scenario: scenario
        }
      );
      
      // Configure tool synthesis to fail
      failingToolSynthesis.setShouldFail(true);
      
      const mockTurn = {
        id: 'test-turn',
        conversationId: 'test-conversation',
        agentId: 'other-agent',
        content: 'Look up patient John Smith',
        timestamp: new Date(),
        status: 'completed' as const
      };
      
      // Process should not throw
      await expect((agent as any).processAndReply(mockTurn)).resolves.toBeUndefined();
      
      // Verify the agent handled the tool error gracefully
      // The agent should continue processing after a tool failure
      expect(mockClient.completeTurnCalls.length).toBeGreaterThan(0);
    });
  });
});