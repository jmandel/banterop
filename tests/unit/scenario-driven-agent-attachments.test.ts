import { describe, it, expect, beforeEach } from 'bun:test';
import { createAgent } from '$agents/factory.js';
import { ToolSynthesisService } from '$agents/services/tool-synthesis.service.js';
import type { 
  ScenarioDrivenAgentConfig, ScenarioConfiguration,
  TraceEntry, ToolResultEntry, AttachmentPayload, AgentInterface 
} from '$lib/types.js';
import { LLMProvider } from '$lib/types.js';
import type { OrchestratorClient } from '$client/index.js';
import { v4 as uuidv4 } from 'uuid';
import { ConversationDatabase } from '$backend/db/database.js';

// Mock implementations
class MockOrchestratorClient implements Partial<OrchestratorClient> {
  conversationId = 'test-conversation';
  completeTurnCalls: any[] = [];
  createdAttachments: AttachmentPayload[] = [];
  currentTurnId: string | null = null;
  
  on(event: string, handler: any): OrchestratorClient { return this as any; }
  async startTurn() { 
    this.currentTurnId = uuidv4();
    return this.currentTurnId; 
  }
  async addTrace(turnId: string, trace: any) { return trace; }
  async addThought(turnId: string, content: string) { 
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
  async completeTurn(turnId: string, content: string, isFinalTurn?: boolean, metadata?: any, attachments?: AttachmentPayload[]) {
    this.completeTurnCalls.push({ turnId, content, isFinalTurn, metadata, attachments });
    if (attachments) {
      this.createdAttachments.push(...attachments);
    }
    this.currentTurnId = null;
    // Simulate returned attachment IDs
    const attachmentIds = attachments?.map(() => `att_${uuidv4()}`) || [];
    return { id: turnId, content, attachments: attachmentIds } as any;
  }
  async getConversation() {
    return { turns: [], metadata: {} } as any;
  }
  async endConversation() {}
  async getAttachment(attachmentId: string) {
    return null;
  }
  async getAttachmentByDocId(conversationId: string, docId: string) {
    return null;
  }
}

class MockLLMProvider extends LLMProvider {
  private responses: string[] = [];
  private responseIndex = 0;

  constructor() {
    super({ provider: 'google', apiKey: 'test-key' });
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

class MockToolSynthesis extends ToolSynthesisService {
  private mockResults: Map<string, any> = new Map();

  setMockResult(toolName: string, result: any) {
    this.mockResults.set(toolName, result);
  }

  async executeToolCall(toolCall: any, conversation: any, agentConfig: any): Promise<any> {
    const result = this.mockResults.get(toolCall.name) || { error: 'Tool not found' };
    return result;
  }
}

// Test suite
describe('ScenarioDrivenAgent Attachment Handling', () => {
  let mockClient: MockOrchestratorClient;
  let mockLLM: MockLLMProvider;
  let mockToolSynthesis: MockToolSynthesis;
  let agent: AgentInterface;
  let scenario: ScenarioConfiguration;
  let mockDb: ConversationDatabase;

  beforeEach(() => {
    mockClient = new MockOrchestratorClient();
    mockLLM = new MockLLMProvider();
    mockToolSynthesis = new MockToolSynthesis(mockLLM);
    
    scenario = {
      id: 'test-scenario',
      agents: [{
        agentId: "test-agent",
        llmEndpoint: { provider: 'test', model: 'test' },
        tools: [
          {
            name: 'send_message_to_agent_conversation',
            description: 'Send a message',
            parameters: {}
          }
        ]
      }],
      patientAgent: {
        agentId: 'patient',
        llmEndpoint: { provider: 'test', model: 'test' },
        tools: [
          {
            name: 'send_message_to_agent_conversation',
            description: 'Send a message',
            parameters: {}
          }
        ]
      },
      supplierAgent: {
        agentId: 'supplier',
        llmEndpoint: { provider: 'test', model: 'test' },
        tools: []
      },
      tools: [{
        name: 'get_medical_records',
        description: 'Get medical records',
        parameters: {},
        output: { schema: {} }
      }, {
        name: 'resolve_document_reference',
        description: 'Resolve document reference',
        parameters: { refToDocId: { type: 'string' } },
        output: { schema: {} }
      }]
    } as any;
    
    const config: ScenarioDrivenAgentConfig = {
      id: "test-agent",
      strategyType: 'scenario_driven',
      scenarioId: 'test-scenario'
    };
    
    mockDb = new ConversationDatabase(':memory:');
    
    agent = createAgent(
      config,
      mockClient as any,
      {
        db: mockDb,
        llmProvider: mockLLM,
        toolSynthesisService: mockToolSynthesis,
        scenario: scenario
      }
    );
  });

  describe('Read Before Attach Validation', () => {
    it('should attach documents whose docId appears in conversation history', async () => {
      // Set up available documents in the agent
      (agent as any).availableDocuments = new Map([
        ['doc_valid', {
          docId: 'doc_valid',
          content: '# Valid Document',
          contentType: 'text/markdown'
        }]
      ]);
      
      // Mock LLM response
      mockLLM.setResponses([
        `<scratchpad>
        I'll send a message with the document attached.
        </scratchpad>
        
        \`\`\`json
        {
          "name": "send_message_to_agent_conversation",
          "args": {
            "text": "Here is the document you requested.",
            "attachments_to_include": ["doc_valid", "doc_invalid"]
          }
        }
        \`\`\``
      ]);
      
      // Initialize agent turn state
      await (agent as any).startTurn();
      
      // Execute tool call
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      await (agent as any).executeSingleToolCallWithReasoning(result);
      
      // Verify completeTurn was called with only one attachment
      expect(mockClient.completeTurnCalls).toHaveLength(1);
      expect(mockClient.completeTurnCalls[0].attachments).toHaveLength(1);
      
      // Verify the attachment payload
      const attachmentPayload = mockClient.completeTurnCalls[0].attachments[0];
      expect(attachmentPayload.docId).toBe('doc_valid');
      expect(attachmentPayload.content).toBe('# Valid Document');
    });

    it('should handle multiple valid docIds from current turn', async () => {
      // Set up multiple available documents
      (agent as any).availableDocuments = new Map([
        ['doc_1', { docId: 'doc_1', content: 'Doc 1', contentType: 'text/markdown' }],
        ['doc_2', { docId: 'doc_2', content: 'Doc 2', contentType: 'text/markdown' }],
        ['doc_3', { docId: 'doc_3', content: 'Doc 3', contentType: 'text/markdown' }]
      ]);
      
      // Mock LLM response
      mockLLM.setResponses([
        `<scratchpad>
        I'll send all documents.
        </scratchpad>
        
        \`\`\`json
        {
          "name": "send_message_to_agent_conversation",
          "args": {
            "text": "Here are all the documents.",
            "attachments_to_include": ["doc_1", "doc_2", "doc_3"]
          }
        }
        \`\`\``
      ]);
      
      // Initialize agent turn state  
      await (agent as any).startTurn();
      
      // Execute
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      await (agent as any).executeSingleToolCallWithReasoning(result);
      
      // Verify all attachments were included
      expect(mockClient.completeTurnCalls).toHaveLength(1);
      expect(mockClient.completeTurnCalls[0].attachments).toHaveLength(3);
    });
  });

  describe('Document Metadata Handling', () => {
    it('should use document name and contentType from the document object', async () => {
      // Set up a document with metadata
      (agent as any).availableDocuments = new Map([
        ['doc_metadata', {
          docId: 'doc_metadata',
          name: 'Patient Summary Report',
          contentType: 'text/html',
          content: '<h1>Patient summary</h1>'
        }]
      ]);
      
      // Mock LLM response
      mockLLM.setResponses([
        `<scratchpad>
        Sending the patient summary.
        </scratchpad>
        
        \`\`\`json
        {
          "name": "send_message_to_agent_conversation",
          "args": {
            "text": "Attached is the patient summary.",
            "attachments_to_include": ["doc_metadata"]
          }
        }
        \`\`\``
      ]);
      
      // Initialize agent turn state  
      await (agent as any).startTurn();
      
      // Execute
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      await (agent as any).executeSingleToolCallWithReasoning(result);
      
      // Verify the attachment was included with correct metadata
      expect(mockClient.completeTurnCalls).toHaveLength(1);
      expect(mockClient.completeTurnCalls[0].attachments).toHaveLength(1);
      const attachmentPayload = mockClient.completeTurnCalls[0].attachments[0];
      expect(attachmentPayload.name).toBe('Patient Summary Report');
      expect(attachmentPayload.contentType).toBe('text/html');
      expect(attachmentPayload.content).toContain('Patient summary');
    });

    it('should handle non-string content by JSON stringifying it', async () => {
      // Add a document with object content
      const objectContent = { data: { patient: 'John Doe', age: 45 } };
      (agent as any).availableDocuments = new Map([
        ['doc_object', {
          docId: 'doc_object',
          name: 'Patient Data',
          contentType: 'application/json',
          content: objectContent
        }]
      ]);
      
      // Mock LLM response
      mockLLM.setResponses([
        `<scratchpad>
        Sending the data object.
        </scratchpad>
        
        \`\`\`json
        {
          "name": "send_message_to_agent_conversation",
          "args": {
            "text": "Here is the patient data.",
            "attachments_to_include": ["doc_object"]
          }
        }
        \`\`\``
      ]);
      
      // Initialize agent turn state  
      await (agent as any).startTurn();
      
      // Execute
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      await (agent as any).executeSingleToolCallWithReasoning(result);
      
      // Verify the content was stringified
      expect(mockClient.completeTurnCalls).toHaveLength(1);
      expect(mockClient.completeTurnCalls[0].attachments).toHaveLength(1);
      const attachmentPayload = mockClient.completeTurnCalls[0].attachments[0];
      const attachedContent = attachmentPayload.content;
      expect(typeof attachedContent).toBe('string');
      expect(JSON.parse(attachedContent)).toEqual(objectContent);
    });
  });
});