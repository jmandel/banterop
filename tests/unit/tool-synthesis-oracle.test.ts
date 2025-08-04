import { describe, test, expect, beforeEach } from 'bun:test';
import { ToolSynthesisService } from '$agents/services/tool-synthesis.service.js';
import { LLMProvider } from 'src/types/llm.types.js';
import type { LLMRequest, LLMResponse } from 'src/types/llm.types.js';
import type { ScenarioConfiguration, Tool } from '$lib/types.js';

// Mock LLM provider for unit testing
class MockLLMProvider extends LLMProvider {
  private responseQueue: string[] = [];
  public lastRequest?: LLMRequest;

  constructor() {
    super({ provider: 'google', apiKey: 'test' });
  }

  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    this.lastRequest = request;
    const content = this.responseQueue.shift() || '```json\n{"reasoning": "Default mock response", "output": "default"}\n```';
    return { content };
  }

  async generateContent(request: LLMRequest): Promise<LLMResponse> {
    return this.generateResponse(request);
  }

  getSupportedModels(): string[] {
    return ['mock-model'];
  }

  // Test helper to queue responses
  queueResponse(content: string) {
    this.responseQueue.push(content);
  }
}

describe('ToolSynthesisService Oracle Implementation', () => {
  let service: ToolSynthesisService;
  let mockLLM: MockLLMProvider;
  let testScenario: ScenarioConfiguration;

  beforeEach(() => {
    mockLLM = new MockLLMProvider();
    service = new ToolSynthesisService(mockLLM);
    
    // Create a minimal test scenario
    testScenario = {
      metadata: {
        id: 'test-scenario',
        title: 'Test Scenario',
        description: 'Test scenario for Oracle',
        tags: ['test']
      },
      scenario: {
        background: 'Test background',
        challenges: ['Test challenge 1', 'Test challenge 2']
      },
      agents: [
        {
          agentId: { id: 'agent1', label: 'Agent 1', role: 'TestAgent' },
          principal: { type: 'individual', name: 'Test User', description: 'Test user' },
          situation: 'Test situation',
          systemPrompt: 'Test prompt',
          goals: ['Goal 1'],
          tools: [
            {
              toolName: 'test_tool',
              description: 'Test tool description',
              inputSchema: { type: 'object', properties: { input: { type: 'string' } } },
              synthesisGuidance: 'Return a test result based on the input'
            }
          ],
          knowledgeBase: { testData: 'test knowledge' }
        }
      ]
    };
  });

  describe('Oracle Prompt Building', () => {
    test('should include all required context sections in prompt', async () => {
      const conversationHistory = 'Previous conversation here';
      
      await service.execute({
        toolName: 'test_tool',
        args: { input: 'test' },
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory
      });

      const prompt = mockLLM.lastRequest?.messages[0].content;
      
      // Check for all major sections
      expect(prompt).toContain('<CONTEXT>');
      expect(prompt).toContain('<SCENARIO_CONTEXT>');
      expect(prompt).toContain('<CONVERSATION_HISTORY_SO_FAR>');
      expect(prompt).toContain('<CALLING_AGENT_PROFILE>');
      expect(prompt).toContain('<OTHER_AGENTS_IN_SCENARIO>');
      expect(prompt).toContain('<TOOL_BEING_EXECUTED>');
      expect(prompt).toContain('<YOUR_TASK>');
      
      // Check specific content
      expect(prompt).toContain('Test Scenario');
      expect(prompt).toContain('Test challenge 1');
      expect(prompt).toContain('Previous conversation here');
      expect(prompt).toContain('test_tool');
      expect(prompt).toContain('Return a test result based on the input');
    });

    test('should include in-progress turn context', async () => {
      const conversationHistory = `From: Agent 1
Timestamp: 2025-01-01T00:00:00Z

Message content here

From: Agent 1 (IN PROGRESS)
Timestamp: 2025-01-01T00:01:00Z

<scratchpad>
Thinking about what to do...
</scratchpad>

\`\`\`json
{"name": "some_tool", "args": {}}
\`\`\`

→ Tool returned:
\`\`\`json
{"result": "previous result"}
\`\`\`

***=>>YOU ARE HERE<<=***`;

      await service.execute({
        toolName: 'test_tool',
        args: { input: 'test' },
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory
      });

      const prompt = mockLLM.lastRequest?.messages[0].content;
      expect(prompt).toContain('IN PROGRESS');
      expect(prompt).toContain('Thinking about what to do...');
      expect(prompt).toContain('***=>>YOU ARE HERE<<=***');
    });
  });

  describe('Oracle Response Parsing', () => {
    test('should parse standard JSON code block response', async () => {
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "Based on the scenario context, returning appropriate test data",
  "output": {
    "status": "success",
    "data": "test result"
  }
}
\`\`\``);

      const result = await service.execute({
        toolName: 'test_tool',
        args: { input: 'test' },
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toEqual({
        status: 'success',
        data: 'test result'
      });
    });

    test('should parse generic code block without json marker', async () => {
      mockLLM.queueResponse(`Some preamble text that might appear

\`\`\`
{
  "reasoning": "The oracle is thinking",
  "output": "simple string output"
}
\`\`\`

Some text after that should be ignored`);

      const result = await service.execute({
        toolName: 'test_tool',
        args: { input: 'test' },
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toBe('simple string output');
    });

    test('should parse bare JSON object without code block', async () => {
      mockLLM.queueResponse(`The oracle responds with:
{
  "reasoning": "Direct JSON response",
  "output": 42
}
That's the response.`);

      const result = await service.execute({
        toolName: 'test_tool',
        args: { input: 'test' },
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toBe(42);
    });

    test('should handle various output types', async () => {
      // Test array output
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "Returning array",
  "output": [1, 2, 3]
}
\`\`\``);

      let result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });
      expect(result.output).toEqual([1, 2, 3]);

      // Test null output
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "Nothing to return",
  "output": null
}
\`\`\``);

      result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });
      expect(result.output).toBe(null);

      // Test boolean output
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "Returning boolean",
  "output": false
}
\`\`\``);

      result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });
      expect(result.output).toBe(false);
    });

    test('should handle nested JSON in output', async () => {
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "Complex nested structure",
  "output": {
    "patient": {
      "id": "123",
      "name": "Test Patient",
      "conditions": ["condition1", "condition2"]
    },
    "authorization": {
      "status": "approved",
      "validUntil": "2025-12-31"
    }
  }
}
\`\`\``);

      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toEqual({
        patient: {
          id: '123',
          name: 'Test Patient',
          conditions: ['condition1', 'condition2']
        },
        authorization: {
          status: 'approved',
          validUntil: '2025-12-31'
        }
      });
    });

    test('should handle response missing reasoning key via fallback', async () => {
      mockLLM.queueResponse(`\`\`\`json
{
  "output": "missing reasoning key"
}
\`\`\``);

      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      // Fallback parsing should work even without reasoning
      expect(result.output).toBe('missing reasoning key');
    });

    test('should return error object when response missing output key', async () => {
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "missing output key"
}
\`\`\``);

      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });
      
      expect(result.output).toMatchObject({
        error: 'Tool synthesis failed',
        message: expect.stringContaining("Oracle LLM response was not valid JSON and fallback parsing failed")
      });
    });

    test('should return error object when no JSON found', async () => {
      mockLLM.queueResponse(`Just plain text without any JSON`);

      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toMatchObject({
        error: 'Tool synthesis failed',
        message: 'Oracle LLM response was not valid JSON and fallback parsing failed.'
      });
    });

    test('should use fallback heuristic when JSON is malformed', async () => {
      // Test case 1: Missing closing quote in output string
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "Valid reasoning",
  "output": "unclosed string
}
\`\`\``);

      let result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toBe('unclosed string\n}');

      // Test case 2: Invalid JSON but has output field with string
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "Some reasoning here",
  "output": "This is the output string",,
}
\`\`\``);

      result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toBe('This is the output string');

      // Test case 3: Invalid JSON but has output field with object
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "Returning object",
  "output": {"status": "success", "data": 123},,,
}
\`\`\``);

      result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toEqual({status: "success", data: 123});
    });

    test('should handle edge cases in fallback parsing', async () => {
      // Test case 1: Output with escaped quotes
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "Testing escaped quotes",
  "output": "She said \\"Hello\\" to me",,
}
\`\`\``);

      let result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toBe('She said "Hello" to me');

      // Test case 2: No reasoning field, should use default
      mockLLM.queueResponse(`\`\`\`json
{
  "output": "Just output, no reasoning",,
}
\`\`\``);

      result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toBe('Just output, no reasoning');
    });

    test('should return error when fallback parsing also fails', async () => {
      // No output field at all
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "Missing output field",
  "result": "This should fail"
}
\`\`\``);

      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toMatchObject({
        error: 'Tool synthesis failed',
        message: expect.stringContaining('Oracle LLM response was not valid JSON and fallback parsing failed')
      });
    });

    test('should handle raw content with output field but no JSON blocks', async () => {
      // This demonstrates the current bug - no code blocks at all, just raw text
      mockLLM.queueResponse(`The reasoning is that we need to process this request.
      "reasoning": "Processing the request",
      "output": "Successfully processed"
      That's the response.`);

      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      // Should succeed with fallback parsing on raw content
      expect(result.output).toBe('Successfully processed');
    });

    test('should handle truncated markdown EHR response', async () => {
      // This is the actual response that was failing
      const truncatedResponse = `{
  "reasoning": "The agent has requested the patient's record with a general query. I will provide a comprehensive summary from the EHR, formatted as a markdown document. This summary includes patient demographics, insurance details, the specific MRI order that is pending authorization, and a summary of recent clinical encounters. This information is crucial for the agent to begin the prior authorization process, as it contains the necessary identifiers, clinical justification, and procedural/diagnostic codes.",
  "output": "\`\`\`markdown
## EHR Patient Summary - CONFIDENTIAL

**Access Time:** 2025-08-02T04:15:27.105Z
**Authorized User:** agent:patient-agent
**EHR System:** UnityHealth EHR v8.2

--- 

### **Patient Information**

*   **Name:** ALVAREZ, JORDAN
*   **MRN:** 8675309
*   **DOB:** 1986-09-15 (Age: 38`;

      mockLLM.queueResponse(truncatedResponse);

      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      // The parser should extract the complete string value, including the markdown code block
      const expectedOutput = `\`\`\`markdown
## EHR Patient Summary - CONFIDENTIAL

**Access Time:** 2025-08-02T04:15:27.105Z
**Authorized User:** agent:patient-agent
**EHR System:** UnityHealth EHR v8.2

--- 

### **Patient Information**

*   **Name:** ALVAREZ, JORDAN
*   **MRN:** 8675309
*   **DOB:** 1986-09-15 (Age: 38`;

      expect(result.output).toBe(expectedOutput);
    });

    test('should fail when JSON is truncated in the middle of a key', async () => {
      // This simulates a more severe truncation where the JSON is cut off mid-key
      const severelyTruncatedResponse = `{
  "reasoning": "The agent has requested the patient's record",
  "ou`;

      mockLLM.queueResponse(severelyTruncatedResponse);

      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      // This should fail and return an error
      expect(result.output).toMatchObject({
        error: 'Tool synthesis failed',
        message: expect.stringContaining('Oracle LLM response was not valid JSON and fallback parsing failed')
      });
    });

    test('should handle JSON truncated after output key but before value', async () => {
      // This simulates truncation right after the output key
      const truncatedAfterKey = `{
  "reasoning": "The agent requested data",
  "output": `;

      mockLLM.queueResponse(truncatedAfterKey);

      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      // This should fail because there's no value after output
      expect(result.output).toMatchObject({
        error: 'Tool synthesis failed',
        message: 'JSON truncated after output key with no value'
      });
    });
  });

  describe('Oracle Error Handling', () => {
    test('should return error object when agent not found', async () => {
      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'non-existent-agent',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toMatchObject({
        error: 'Tool synthesis failed',
        message: "Agent 'non-existent-agent' not found."
      });
    });

    test('should return error object when tool not found', async () => {
      const result = await service.execute({
        toolName: 'non_existent_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toMatchObject({
        error: 'Tool synthesis failed',
        message: "Tool 'non_existent_tool' not found for agent 'agent1'."
      });
    });

    test('should return error object when LLM fails', async () => {
      // Override generateResponse to throw error
      mockLLM.generateResponse = async () => {
        throw new Error('LLM service unavailable');
      };

      const result = await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(result.output).toMatchObject({
        error: 'Tool synthesis failed',
        message: 'LLM service unavailable'
      });
    });
  });

  describe('Oracle Behavioral Tests', () => {
    test('should use temperature 0.7 for creative synthesis', async () => {
      await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(mockLLM.lastRequest?.temperature).toBe(0.7);
    });

    test('should log oracle reasoning to console', async () => {
      // Capture console.log output
      const originalLog = console.log;
      let capturedLog = '';
      console.log = (message: string) => {
        capturedLog = message;
      };
      
      mockLLM.queueResponse(`\`\`\`json
{
  "reasoning": "This is my reasoning for the tool output",
  "output": "result"
}
\`\`\``);

      await service.execute({
        toolName: 'test_tool',
        args: {},
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      expect(capturedLog).toBe('[Oracle Reasoning for test_tool]: This is my reasoning for the tool output');
      
      // Restore console.log
      console.log = originalLog;
    });

    test('should pass all tool arguments to oracle', async () => {
      const complexArgs = {
        patientId: '123',
        dateRange: '2024-01-01 to 2024-12-31',
        includeNotes: true,
        filters: ['urgent', 'reviewed']
      };

      await service.execute({
        toolName: 'test_tool',
        args: complexArgs,
        agentId: 'agent1',
        scenario: testScenario,
        conversationHistory: ''
      });

      const prompt = mockLLM.lastRequest?.messages[0].content;
      expect(prompt).toContain(JSON.stringify(complexArgs, null, 2));
    });
  });
});