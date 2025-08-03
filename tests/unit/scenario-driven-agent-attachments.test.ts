import { describe, it, expect, beforeEach } from 'bun:test';
import { ScenarioDrivenAgent } from '../../src/agents/scenario-driven.agent.js';
import { ToolSynthesisService } from '../../src/agents/services/tool-synthesis.service.js';
import type { 
  OrchestratorClient, ScenarioDrivenAgentConfig, ScenarioConfiguration,
  LLMProvider, TraceEntry, ToolResultEntry 
} from '../../src/types/index.js';
import { v4 as uuidv4 } from 'uuid';

// Mock implementations
class MockOrchestratorClient implements Partial<OrchestratorClient> {
  conversationId = 'test-conversation';
  registerAttachmentCalls: any[] = [];
  completeTurnCalls: any[] = [];
  
  on(event: string, handler: any) { return this; }
  async startTurn() { return uuidv4(); }
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
  async completeTurn(turnId: string, content: string, isFinalTurn?: boolean, metadata?: any, attachments?: string[]) {
    this.completeTurnCalls.push({ turnId, content, isFinalTurn, metadata, attachments });
    return { id: turnId, content, attachments } as any;
  }
  async registerAttachment(params: any) {
    this.registerAttachmentCalls.push(params);
    return `att_${uuidv4()}`;
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

class MockLLMProvider implements LLMProvider {
  modelIdentifier = 'mock-model';
  responses: string[] = [];
  currentResponse = 0;
  
  setResponses(responses: string[]) {
    this.responses = responses;
    this.currentResponse = 0;
  }
  
  async generateResponse() {
    const response = this.responses[this.currentResponse++];
    return { content: response };
  }
}

class MockToolSynthesisService extends ToolSynthesisService {
  mockExecuteResults: Map<string, any> = new Map();
  
  setMockResult(toolName: string, output: any) {
    this.mockExecuteResults.set(toolName, output);
  }
  
  async execute(input: any) {
    const mockResult = this.mockExecuteResults.get(input.toolName);
    if (mockResult) {
      return { output: mockResult };
    }
    return super.execute(input);
  }
}

describe('ScenarioDrivenAgent Attachment Handling', () => {
  let agent: ScenarioDrivenAgent;
  let mockClient: MockOrchestratorClient;
  let mockLLM: MockLLMProvider;
  let mockToolSynthesis: MockToolSynthesisService;
  let scenario: ScenarioConfiguration;
  
  beforeEach(() => {
    mockClient = new MockOrchestratorClient();
    mockLLM = new MockLLMProvider();
    mockToolSynthesis = new MockToolSynthesisService(mockLLM);
    
    scenario = {
      metadata: { 
        title: 'Test Scenario',
        description: 'Test',
        schemaVersion: '2.4'
      },
      scenario: {
        background: 'Test background',
        challenges: []
      },
      agents: [{
        agentId: { id: 'test-agent', label: 'Test Agent', role: 'test' },
        principal: { name: 'Test Principal', description: 'Test' },
        situation: 'Test situation',
        systemPrompt: 'Test prompt',
        goals: ['Test goal'],
        tools: [{
          toolName: 'get_medical_records',
          description: 'Get medical records',
          inputSchema: { type: 'object', properties: {} },
          synthesisGuidance: 'Return medical records with attachment references'
        }]
      }]
    };
    
    const config: ScenarioDrivenAgentConfig = {
      agentId: { id: 'test-agent', label: 'Test Agent', role: 'test' },
      strategyType: 'scenario_driven',
      scenarioId: 'test-scenario'
    };
    
    agent = new ScenarioDrivenAgent(
      config,
      mockClient as any,
      scenario,
      mockLLM,
      mockToolSynthesis
    );
  });

  describe('Deterministic Reification', () => {
    it('should wrap tool outputs without docId in document structure', async () => {
      const currentTurnTrace: TraceEntry[] = [];
      
      // Mock tool synthesis to return a plain object without docId
      mockToolSynthesis.setMockResult('get_medical_records', {
        patientId: '12345',
        records: ['Record 1', 'Record 2']
      });
      
      // Mock LLM response
      mockLLM.setResponses([
        `<scratchpad>
        I need to get medical records for the patient.
        </scratchpad>
        
        \`\`\`json
        {
          "name": "get_medical_records",
          "args": {}
        }
        \`\`\``
      ]);
      
      // Execute tool call
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      const stepResult = await (agent as any).executeSingleToolCallWithReasoning(result, currentTurnTrace);
      
      // Find the tool result in the trace
      const toolResultEntry = currentTurnTrace.find(t => t.type === 'tool_result') as ToolResultEntry;
      expect(toolResultEntry).toBeTruthy();
      
      // Verify the output was wrapped with docId
      expect(toolResultEntry.result).toHaveProperty('docId');
      expect(toolResultEntry.result.docId).toBe(toolResultEntry.toolCallId);
      expect(toolResultEntry.result.contentType).toBe('application/json');
      expect(toolResultEntry.result.content).toEqual({
        patientId: '12345',
        records: ['Record 1', 'Record 2']
      });
    });

    it('should not wrap tool outputs that already have docId', async () => {
      const currentTurnTrace: TraceEntry[] = [];
      
      // Mock tool synthesis to return a document with docId
      mockToolSynthesis.setMockResult('resolve_document_reference', {
        docId: 'doc_12345',
        contentType: 'text/markdown',
        content: '# Medical Record\n\nPatient details...'
      });
      
      // Mock LLM response
      mockLLM.setResponses([
        `<scratchpad>
        I need to read the document reference.
        </scratchpad>
        
        \`\`\`json
        {
          "name": "resolve_document_reference",
          "args": {
            "refToDocId": "ref_12345"
          }
        }
        \`\`\``
      ]);
      
      // Execute tool call
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      const stepResult = await (agent as any).executeSingleToolCallWithReasoning(result, currentTurnTrace);
      
      // Find the tool result in the trace
      const toolResultEntry = currentTurnTrace.find(t => t.type === 'tool_result') as ToolResultEntry;
      expect(toolResultEntry).toBeTruthy();
      
      // Verify the output was NOT wrapped (already has docId)
      expect(toolResultEntry.result.docId).toBe('doc_12345');
      expect(toolResultEntry.result.contentType).toBe('text/markdown');
      expect(toolResultEntry.result.content).toBe('# Medical Record\n\nPatient details...');
    });
  });

  describe('Read Before Attach Validation', () => {
    it('should attach documents whose docId appears in conversation history', async () => {
      const currentTurnTrace: TraceEntry[] = [];
      
      // First, simulate reading a document
      const toolCallEntry1: any = {
        id: uuidv4(),
        type: 'tool_call',
        toolName: 'resolve_document_reference',
        toolCallId: 'call_1',
        agentId: 'test-agent',
        timestamp: new Date()
      };
      
      const toolResultEntry1: ToolResultEntry = {
        id: uuidv4(),
        type: 'tool_result',
        toolCallId: 'call_1',
        result: {
          docId: 'doc_valid',
          contentType: 'text/markdown',
          content: '# Valid Document'
        },
        agentId: 'test-agent',
        timestamp: new Date()
      };
      
      currentTurnTrace.push(toolCallEntry1, toolResultEntry1);
      
      // Populate the agent's available documents from the trace
      agent.populateDocumentsFromTrace(currentTurnTrace);
      
      // Mock LLM response to send message with attachments
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
      
      // Execute tool call
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      await (agent as any).executeSingleToolCallWithReasoning(result, currentTurnTrace);
      
      // Verify only the valid document was attached
      expect(mockClient.registerAttachmentCalls).toHaveLength(1);
      expect(mockClient.registerAttachmentCalls[0].content).toBe('# Valid Document');
      
      // Verify completeTurn was called with only one attachment
      expect(mockClient.completeTurnCalls).toHaveLength(1);
      expect(mockClient.completeTurnCalls[0].attachments).toHaveLength(1);
    });

    it('should attach documents from previous turns', async () => {
      const currentTurnTrace: TraceEntry[] = [];
      
      // Simulate a document from a previous turn stored in the agent's trace map
      const previousTurnId = 'turn_previous';
      const previousTurnTraces: TraceEntry[] = [{
        id: uuidv4(),
        type: 'tool_result',
        toolCallId: 'call_prev',
        result: {
          docId: 'doc_from_previous_turn',
          contentType: 'text/markdown',
          content: '# Previous Turn Document'
        },
        agentId: 'test-agent',
        timestamp: new Date()
      } as ToolResultEntry];
      
      // Store the previous turn traces
      (agent as any).tracesByTurnId.set(previousTurnId, previousTurnTraces);
      
      // Populate the agent's available documents from the previous turn trace
      agent.populateDocumentsFromTrace(previousTurnTraces);
      
      // Mock LLM response to send message with attachment from previous turn
      mockLLM.setResponses([
        `<scratchpad>
        I'll attach the document from the previous turn.
        </scratchpad>
        
        \`\`\`json
        {
          "name": "send_message_to_agent_conversation",
          "args": {
            "text": "Here is the document from our earlier discussion.",
            "attachments_to_include": ["doc_from_previous_turn"]
          }
        }
        \`\`\``
      ]);
      
      // Execute tool call
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      await (agent as any).executeSingleToolCallWithReasoning(result, currentTurnTrace);
      
      // Verify the document from previous turn was attached
      expect(mockClient.registerAttachmentCalls).toHaveLength(1);
      expect(mockClient.registerAttachmentCalls[0].content).toBe('# Previous Turn Document');
      expect(mockClient.completeTurnCalls[0].attachments).toHaveLength(1);
    });

    it('should handle multiple valid docIds from current turn', async () => {
      const currentTurnTrace: TraceEntry[] = [];
      
      // Simulate reading multiple documents
      const docs = [
        { docId: 'doc_1', content: 'Document 1' },
        { docId: 'doc_2', content: 'Document 2' },
        { docId: 'doc_3', content: 'Document 3' }
      ];
      
      for (let i = 0; i < docs.length; i++) {
        currentTurnTrace.push({
          id: uuidv4(),
          type: 'tool_result',
          toolCallId: `call_${i}`,
          result: {
            docId: docs[i].docId,
            contentType: 'text/plain',
            content: docs[i].content
          },
          agentId: 'test-agent',
          timestamp: new Date()
        } as ToolResultEntry);
      }
      
      // Populate the agent's available documents from the current turn trace
      agent.populateDocumentsFromTrace(currentTurnTrace);
      
      // Mock LLM response to send message with all attachments
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
      
      // Execute tool call
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      await (agent as any).executeSingleToolCallWithReasoning(result, currentTurnTrace);
      
      // Verify all documents were attached
      expect(mockClient.registerAttachmentCalls).toHaveLength(3);
      expect(mockClient.completeTurnCalls[0].attachments).toHaveLength(3);
    });
  });

  describe('Document Metadata Handling', () => {
    it('should use document name and contentType from the document object', async () => {
      const currentTurnTrace: TraceEntry[] = [];
      
      // Add a document with full metadata to the trace
      currentTurnTrace.push({
        id: uuidv4(),
        type: 'tool_result',
        toolCallId: 'call_1',
        result: {
          docId: 'doc_metadata',
          name: 'Patient Summary Report',
          contentType: 'text/html',
          content: '<html><body>Patient summary...</body></html>'
        },
        agentId: 'test-agent',
        timestamp: new Date()
      } as ToolResultEntry);
      
      // Populate the agent's available documents from the trace
      agent.populateDocumentsFromTrace(currentTurnTrace);
      
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
      
      // Execute
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      await (agent as any).executeSingleToolCallWithReasoning(result, currentTurnTrace);
      
      // Verify the attachment was registered with correct metadata
      expect(mockClient.registerAttachmentCalls).toHaveLength(1);
      const registeredAttachment = mockClient.registerAttachmentCalls[0];
      expect(registeredAttachment.name).toBe('Patient Summary Report');
      expect(registeredAttachment.contentType).toBe('text/html');
      expect(registeredAttachment.content).toContain('Patient summary');
    });

    it('should handle non-string content by JSON stringifying it', async () => {
      const currentTurnTrace: TraceEntry[] = [];
      
      // Add a document with object content
      const objectContent = { data: { patient: 'John Doe', age: 45 } };
      currentTurnTrace.push({
        id: uuidv4(),
        type: 'tool_result',
        toolCallId: 'call_1',
        result: {
          docId: 'doc_object',
          contentType: 'application/json',
          content: objectContent
        },
        agentId: 'test-agent',
        timestamp: new Date()
      } as ToolResultEntry);
      
      // Populate the agent's available documents from the trace
      agent.populateDocumentsFromTrace(currentTurnTrace);
      
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
      
      // Execute
      const result = await (agent as any).extractToolCallsFromLLMResponse('test prompt');
      await (agent as any).executeSingleToolCallWithReasoning(result, currentTurnTrace);
      
      // Verify the content was stringified
      expect(mockClient.registerAttachmentCalls).toHaveLength(1);
      const registeredContent = mockClient.registerAttachmentCalls[0].content;
      expect(typeof registeredContent).toBe('string');
      expect(JSON.parse(registeredContent)).toEqual(objectContent);
    });
  });
});