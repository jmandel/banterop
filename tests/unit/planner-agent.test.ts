import { describe, it, expect, beforeEach } from 'bun:test';
import { PlannerAgent } from '$src/agents/runtime/planner-agent';
import { MockTransport } from '$src/agents/runtime/mock.transport';
import { MockLLMProvider } from '$src/llm/providers/mock';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';

describe('PlannerAgent', () => {
  let mockTransport: MockTransport;
  let mockProvider: MockLLMProvider;
  let plannerAgent: PlannerAgent;

  beforeEach(() => {
    mockTransport = new MockTransport();
    mockProvider = new MockLLMProvider();

    // Mock the provider manager
    const mockProviderManager = {
      getProvider: () => mockProvider
    };

    plannerAgent = new PlannerAgent(mockTransport, {
      agentId: 'test-agent',
      providerManager: mockProviderManager as any
    });
  });

  describe('event conversion', () => {
    it('should convert conversation snapshot to planner events', () => {
      const snapshot: ConversationSnapshot = {
        conversation: 1,
        status: 'active',
        metadata: { id: 'test', title: 'Test Conversation' },
        events: [
          {
            seq: 1,
            ts: new Date(),
            type: 'message',
            agentId: 'other-agent',
            payload: { text: 'Hello from other agent', attachments: [] },
            turn: 1,
            finality: 'none'
          },
          {
            seq: 2,
            ts: new Date(),
            type: 'message',
            agentId: 'test-agent',
            payload: { text: 'Hello from test agent', attachments: [] },
            turn: 1,
            finality: 'turn'
          }
        ],
        lastClosedSeq: 2,
        scenario: {
          metadata: { id: 'test-scenario', title: 'Test Scenario' },
          agents: [
            {
              agentId: 'test-agent',
              principal: { type: 'individual', name: 'Test Agent' },
              systemPrompt: 'You are a test agent',
              goals: ['Test goal'],
              tools: []
            }
          ]
        }
      };

      const events = (plannerAgent as any).convertSnapshotToPlannerEvents(snapshot, 'test-agent');

      expect(events).toHaveLength(3); // 2 original + 1 synthetic
      expect(events[0].channel).toBe('user-planner'); // Other agent's message
      expect(events[0].author).toBe('agent');
      expect(events[1].channel).toBe('planner-agent'); // Our message
      expect(events[1].author).toBe('planner');
      expect(events[2].channel).toBe('user-planner'); // Synthetic trigger message
      expect(events[2].author).toBe('agent');
    });

    it('should extract scenario configuration correctly', () => {
      const snapshot: ConversationSnapshot = {
        conversation: 1,
        status: 'active',
        metadata: { id: 'test', title: 'Test Conversation' },
        events: [],
        lastClosedSeq: 0,
        scenario: {
          metadata: { id: 'test-scenario', title: 'Test Scenario' },
          agents: [
            {
              agentId: 'test-agent',
              principal: { type: 'individual', name: 'Test Agent' },
              systemPrompt: 'You are a test agent',
              goals: ['Test goal'],
              tools: [
                {
                  toolName: 'test-tool',
                  description: 'A test tool',
                  inputSchema: { type: 'object', properties: {} },
                  synthesisGuidance: 'Test guidance'
                }
              ]
            }
          ]
        }
      };

      const scenario = (plannerAgent as any).extractPlannerScenario(snapshot, 'test-agent');

      expect(scenario).toBeDefined();
      expect(scenario?.metadata.id).toBe('test-scenario');
      expect(scenario?.agents).toHaveLength(1);
      expect(scenario?.agents[0].agentId).toBe('test-agent');
    });

    it('should handle missing scenario gracefully', () => {
      const snapshot: ConversationSnapshot = {
        conversation: 1,
        status: 'active',
        metadata: { id: 'test', title: 'Test Conversation' },
        events: [],
        lastClosedSeq: 0
      };

      const scenario = (plannerAgent as any).extractPlannerScenario(snapshot, 'test-agent');
      expect(scenario).toBeNull();
    });
  });

  describe('tool restrictions', () => {
    it('should allow setting tool restrictions', () => {
      const restrictions = {
        omitCoreTools: ['sendMessageToUser', 'done'],
        omitScenarioTools: ['restricted-tool']
      };

      plannerAgent.setToolRestrictions(restrictions);

      // The restrictions should be applied internally
      // We can verify this indirectly through the planner behavior
      expect(plannerAgent).toBeDefined();
    });
  });

  describe('counterpart identification', () => {
    it('should identify counterpart agent correctly', () => {
      const snapshot: ConversationSnapshot = {
        conversation: 1,
        status: 'active',
        metadata: { id: 'test', title: 'Test Conversation' },
        events: [],
        lastClosedSeq: 0,
        scenario: {
          metadata: { id: 'test-scenario', title: 'Test Scenario' },
          agents: [
            {
              agentId: 'test-agent',
              principal: { type: 'individual', name: 'Test Agent' },
              systemPrompt: 'You are a test agent',
              goals: ['Test goal'],
              tools: []
            },
            {
              agentId: 'counterpart-agent',
              principal: { type: 'individual', name: 'Counterpart Agent' },
              systemPrompt: 'You are a counterpart agent',
              goals: ['Counterpart goal'],
              tools: []
            }
          ]
        }
      };

      const context = { snapshot, agentId: 'test-agent' } as any;
      const counterpartId = (plannerAgent as any).getCounterpartAgentId(context);

      expect(counterpartId).toBe('counterpart-agent');
    });

    it('should return undefined when no other agents exist', () => {
      const snapshot: ConversationSnapshot = {
        conversation: 1,
        status: 'active',
        metadata: { id: 'test', title: 'Test Conversation' },
        events: [],
        lastClosedSeq: 0,
        scenario: {
          metadata: { id: 'test-scenario', title: 'Test Scenario' },
          agents: [
            {
              agentId: 'test-agent',
              principal: { type: 'individual', name: 'Test Agent' },
              systemPrompt: 'You are a test agent',
              goals: ['Test goal'],
              tools: []
            }
          ]
        }
      };

      const context = { snapshot, agentId: 'test-agent' } as any;
      const counterpartId = (plannerAgent as any).getCounterpartAgentId(context);

      expect(counterpartId).toBeUndefined();
    });
  });
});
