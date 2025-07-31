// Unit tests for ScenarioDrivenAgent formatting helpers
import { test, expect, describe, beforeEach } from 'bun:test';
import { ConversationTurn, TraceEntry, ToolCallEntry, ToolResultEntry, ThoughtEntry } from '$lib/types.js';

// Create a mock agent class to test the formatting methods
class MockScenarioDrivenAgent {
  private agentId = { id: 'test-agent', label: 'Test Agent' };
  private tracesByTurnId: Map<string, TraceEntry[]> = new Map();

  // Copy the private formatting methods from ScenarioDrivenAgent for testing
  formatTimestamp(date: Date | string): string {
    const d = typeof date === 'string' ? new Date(date) : date;
    return d.toISOString().replace('T', ' ').substring(0, 19);
  }

  formatOtherAgentTurn(turn: ConversationTurn): string {
    const timestamp = this.formatTimestamp(turn.timestamp);
    return `[${timestamp}] [${turn.agentId}]\n${turn.content}`;
  }

  formatOwnTurnForHistory(turn: ConversationTurn): string {
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

  formatCurrentProcess(currentTurnTrace: TraceEntry[]): string {
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

  // Helper method to set traces for testing
  setTraces(turnId: string, traces: TraceEntry[]) {
    this.tracesByTurnId.set(turnId, traces);
  }
}

describe('ScenarioDrivenAgent Formatting Helpers', () => {
  let agent: MockScenarioDrivenAgent;
  
  beforeEach(() => {
    agent = new MockScenarioDrivenAgent();
  });

  describe('formatTimestamp', () => {
    test('should format Date object to YYYY-MM-DD HH:mm:ss', () => {
      const date = new Date('2024-07-01T10:30:15.123Z');
      const result = agent.formatTimestamp(date);
      expect(result).toBe('2024-07-01 10:30:15');
    });

    test('should format ISO string to YYYY-MM-DD HH:mm:ss', () => {
      const dateString = '2024-07-01T10:30:15.123Z';
      const result = agent.formatTimestamp(dateString);
      expect(result).toBe('2024-07-01 10:30:15');
    });
  });

  describe('formatOtherAgentTurn', () => {
    test('should format other agent turn with timestamp and content', () => {
      const turn: ConversationTurn = {
        id: 'turn-1',
        conversationId: 'conv-1',
        agentId: 'other-agent',
        content: 'Hello, I need help with authorization.',
        timestamp: new Date('2024-07-01T10:30:15.123Z'),
        isFinalTurn: false,
        trace: [],
        status: 'completed',
        startedAt: new Date('2024-07-01T10:30:15.123Z')
      };

      const result = agent.formatOtherAgentTurn(turn);
      expect(result).toBe('[2024-07-01 10:30:15] [other-agent]\nHello, I need help with authorization.');
    });
  });

  describe('formatOwnTurnForHistory', () => {
    test('should format own turn with scratchpad, tool call, and result', () => {
      const turn: ConversationTurn = {
        id: 'turn-1',
        conversationId: 'conv-1',
        agentId: 'test-agent',
        content: 'I will check the authorization status.',
        timestamp: new Date('2024-07-01T10:30:15.123Z'),
        isFinalTurn: false,
        trace: [],
        status: 'completed',
        startedAt: new Date('2024-07-01T10:30:15.123Z')
      };

      const traces: TraceEntry[] = [
        {
          id: 'trace-1',
          agentId: 'test-agent',
          timestamp: new Date('2024-07-01T10:30:15.123Z'),
          type: 'thought',
          content: 'I need to check the patient authorization'
        } as ThoughtEntry,
        {
          id: 'trace-2',
          agentId: 'test-agent',
          timestamp: new Date('2024-07-01T10:30:15.123Z'),
          type: 'tool_call',
          toolName: 'check_authorization',
          parameters: { patientId: '123' },
          toolCallId: 'call-1'
        } as ToolCallEntry,
        {
          id: 'trace-3',
          agentId: 'test-agent',
          timestamp: new Date('2024-07-01T10:30:15.123Z'),
          type: 'tool_result',
          toolCallId: 'call-1',
          result: { status: 'approved' }
        } as ToolResultEntry
      ];

      // Set up the traces in the agent's local state
      agent.setTraces('turn-1', traces);

      const result = agent.formatOwnTurnForHistory(turn);
      
      expect(result).toContain('[2024-07-01 10:30:15] [Test Agent]');
      expect(result).toContain('<scratchpad>\nI need to check the patient authorization\n</scratchpad>');
      expect(result).toContain('```json\n{\n  "name": "check_authorization",\n  "args": {\n    "patientId": "123"\n  }\n}\n```');
      expect(result).toContain('[TOOL_RESULT] {"status":"approved"}');
      expect(result).toContain('I will check the authorization status.');
    });

    test('should handle turn with no traces', () => {
      const turn: ConversationTurn = {
        id: 'turn-2',
        conversationId: 'conv-1',
        agentId: 'test-agent',
        content: 'Simple message without tool use.',
        timestamp: new Date('2024-07-01T10:30:15.123Z'),
        isFinalTurn: false,
        trace: [],
        status: 'completed',
        startedAt: new Date('2024-07-01T10:30:15.123Z')
      };

      const result = agent.formatOwnTurnForHistory(turn);
      
      expect(result).toContain('[2024-07-01 10:30:15] [Test Agent]');
      expect(result).toContain('<scratchpad>\nNo thoughts recorded.\n</scratchpad>');
      expect(result).toContain('Simple message without tool use.');
      expect(result).not.toContain('```json');
      expect(result).not.toContain('[TOOL_RESULT]');
    });
  });

  describe('formatCurrentProcess', () => {
    test('should show "YOU ARE HERE" with no actions taken', () => {
      const result = agent.formatCurrentProcess([]);
      
      expect(result).toContain('<ourCurrentProcess>');
      expect(result).toContain('<!-- No actions taken yet in this turn -->');
      expect(result).toContain('***=>>YOU ARE HERE<<=***');
      expect(result).toContain('</ourCurrentProcess>');
    });

    test('should format current process with actions taken', () => {
      const currentTrace: TraceEntry[] = [
        {
          id: 'trace-1',
          agentId: 'test-agent',
          timestamp: new Date(),
          type: 'thought',
          content: 'I am thinking about this problem'
        } as ThoughtEntry,
        {
          id: 'trace-2',
          agentId: 'test-agent',
          timestamp: new Date(),
          type: 'tool_call',
          toolName: 'analyze_data',
          parameters: { data: 'sample' },
          toolCallId: 'call-1'
        } as ToolCallEntry
      ];

      const result = agent.formatCurrentProcess(currentTrace);
      
      expect(result).toContain('<ourCurrentProcess>');
      expect(result).toContain('<scratchpad>\nI am thinking about this problem\n</scratchpad>');
      expect(result).toContain('```json\n{\n  "name": "analyze_data",\n  "args": {\n    "data": "sample"\n  }\n}\n```');
      expect(result).toContain('***=>>YOU ARE HERE<<=***');
      expect(result).toContain('</ourCurrentProcess>');
    });
  });
});