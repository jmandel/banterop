import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { startScenarioAgents, createScenarioConversation } from './scenario-agent.factory';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { ProviderManager } from '$src/llm/provider-manager';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import type { HydratedConversationSnapshot } from '$src/types/orchestrator.types';
import { MockLLMProvider } from '$src/llm/providers/mock';

describe('scenario-agent.factory', () => {
  let mockOrchestrator: Partial<OrchestratorService>;
  let mockProviderManager: Partial<ProviderManager>;
  let testScenario: ScenarioConfiguration;

  beforeEach(() => {
    testScenario = {
      metadata: {
        id: 'test-scenario',
        title: 'Test Scenario',
        description: 'A test scenario',
      },
      scenario: {
        background: 'Test background',
        challenges: ['Test challenge'],
      },
      agents: [
        {
          agentId: 'agent-1',
          principal: {
            type: 'individual',
            name: 'Agent 1',
            description: 'First agent',
          },
          situation: 'Test situation',
          systemPrompt: 'You are agent 1',
          goals: ['Goal 1'],
          tools: [],
          knowledgeBase: {},
        },
        {
          agentId: 'agent-2',
          principal: {
            type: 'individual',
            name: 'Agent 2',
            description: 'Second agent',
          },
          situation: 'Test situation',
          systemPrompt: 'You are agent 2',
          goals: ['Goal 2'],
          tools: [],
          knowledgeBase: {},
        },
      ],
    };

    mockOrchestrator = {
      getHydratedConversationSnapshot: mock((id: number) => ({
        conversation: id,
        status: 'active' as const,
        events: [],
        scenario: testScenario,
        runtimeMeta: {
          agents: [
            { id: 'agent-1', kind: 'internal' as const },
            { id: 'agent-2', kind: 'external' as const },
          ],
        },
      } as HydratedConversationSnapshot)),
      createConversation: mock(() => 1),
      appendEvent: mock(() => ({ seq: 1, turn: 1, event: 1, conversation: 1, ts: new Date().toISOString() })),
      subscribe: mock(() => 'sub-id'),
      unsubscribe: mock(() => {}),
      claimTurn: mock(() => Promise.resolve({ ok: false, reason: 'test' })),
    };

    mockProviderManager = {
      getProvider: mock(() => new MockLLMProvider({ provider: 'mock' })),
    };
  });

  describe('startScenarioAgents', () => {
    it('starts internal agents based on runtime metadata', async () => {
      const handle = await startScenarioAgents(
        mockOrchestrator as OrchestratorService,
        1,
        {
          providerManager: mockProviderManager as ProviderManager,
        }
      );

      expect(handle.agents).toHaveLength(1); // Only agent-1 is internal
      expect(mockOrchestrator.getHydratedConversationSnapshot).toHaveBeenCalledWith(1);
      
      // Clean up
      await handle.stop();
    });

    it('starts specific agents when agentIds provided', async () => {
      const handle = await startScenarioAgents(
        mockOrchestrator as OrchestratorService,
        1,
        {
          providerManager: mockProviderManager as ProviderManager,
          agentIds: ['agent-1', 'agent-2'],
        }
      );

      expect(handle.agents).toHaveLength(2); // Both agents requested
      
      // Clean up
      await handle.stop();
    });

    it('returns empty handle when no internal agents', async () => {
      mockOrchestrator.getHydratedConversationSnapshot = mock(() => ({
        conversation: 1,
        status: 'active' as const,
        events: [],
        scenario: testScenario,
        runtimeMeta: {
          agents: [
            { id: 'agent-1', kind: 'external' as const },
            { id: 'agent-2', kind: 'external' as const },
          ],
        },
      } as HydratedConversationSnapshot));

      const handle = await startScenarioAgents(
        mockOrchestrator as OrchestratorService,
        1,
        {
          providerManager: mockProviderManager as ProviderManager,
        }
      );

      expect(handle.agents).toHaveLength(0);
      await handle.stop(); // Should not throw
    });

    it('throws error for agents not in scenario', async () => {
      await expect(
        startScenarioAgents(
          mockOrchestrator as OrchestratorService,
          1,
          {
            providerManager: mockProviderManager as ProviderManager,
            agentIds: ['agent-1', 'unknown-agent'],
          }
        )
      ).rejects.toThrow('Config error: runtime agent "unknown-agent" not found in scenario "test-scenario"');
    });

    it('throws when conversation not hydrated', async () => {
      mockOrchestrator.getHydratedConversationSnapshot = mock(() => null);

      await expect(
        startScenarioAgents(
          mockOrchestrator as OrchestratorService,
          1,
          {
            providerManager: mockProviderManager as ProviderManager,
          }
        )
      ).rejects.toThrow('Conversation 1 is not hydrated with a scenario');
    });
  });

  describe('createScenarioConversation', () => {
    it('creates conversation and starts internal agents', async () => {
      const { conversationId, handle } = await createScenarioConversation(
        mockOrchestrator as OrchestratorService,
        mockProviderManager as ProviderManager,
        {
          scenarioId: 'test-scenario',
          title: 'Test Conversation',
          agents: [
            { id: 'agent-1', kind: 'internal' },
            { id: 'agent-2', kind: 'external' },
          ],
        }
      );

      expect(conversationId).toBe(1);
      expect(mockOrchestrator.createConversation).toHaveBeenCalledWith({
        scenarioId: 'test-scenario',
        title: 'Test Conversation',
        agents: [
          { id: 'agent-1', kind: 'internal' },
          { id: 'agent-2', kind: 'external' },
        ],
      });
      expect(handle.agents).toHaveLength(1); // Only internal agent started
      
      // Clean up
      await handle.stop();
    });

    it('supports starting agent configuration', async () => {
      await createScenarioConversation(
        mockOrchestrator as OrchestratorService,
        mockProviderManager as ProviderManager,
        {
          scenarioId: 'test-scenario',
          agents: [
            { id: 'agent-1', kind: 'external' },
            { id: 'agent-2', kind: 'internal' },
          ],
          startingAgentId: 'agent-1',
        }
      );

      expect(mockOrchestrator.createConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          startingAgentId: 'agent-1',
        })
      );
    });

    it('passes custom metadata through', async () => {
      await createScenarioConversation(
        mockOrchestrator as OrchestratorService,
        mockProviderManager as ProviderManager,
        {
          scenarioId: 'test-scenario',
          agents: [
            { id: 'agent-1', kind: 'internal' },
          ],
          custom: {
            testData: 'value',
          },
        }
      );

      expect(mockOrchestrator.createConversation).toHaveBeenCalledWith(
        expect.objectContaining({
          custom: { testData: 'value' },
        })
      );
    });
  });
});