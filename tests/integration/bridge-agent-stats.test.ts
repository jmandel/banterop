import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { ConversationOrchestrator } from '../../src/backend/core/orchestrator.js';
import { BridgeAgent } from '../../src/agents/bridge.agent.js';
import { LLMProvider } from '../../src/types/llm.types.js';
import type { ScenarioConfiguration } from '../../src/types/scenario-configuration.types.js';
import type { AgentConfig } from '../../src/types/agent.types.js';

// Mock LLM provider for testing
class MockLLMProvider extends LLMProvider {
  async generateResponseImpl() {
    return { 
      content: 'Mock response', 
      usage: { inputTokens: 0, outputTokens: 0 } 
    };
  }
  
  getDescription() {
    return 'Mock LLM Provider';
  }
}

describe('BridgeAgent Stats Tracking', () => {
  let orchestrator: ConversationOrchestrator;
  
  beforeEach(() => {
    // Initialize orchestrator with in-memory database and mock LLM
    orchestrator = new ConversationOrchestrator(
      ':memory:',
      new MockLLMProvider({ apiKey: 'mock' })
    );
  });
  
  afterEach(() => {
    // Clean up after each test
    orchestrator = null as any;
  });
  
  it('should track other agent actions correctly', async () => {
    // Create a test scenario with bridge agent and sequential script agent
    const scenarioConfig: ScenarioConfiguration = {
      id: 'test-scenario',
      version: '1.0',
      schemaVersion: '2.4',
      metadata: {
        id: 'test-scenario',
        title: 'Bridge Stats Test',
        description: 'Testing stats tracking in bridge agent',
        tags: ['test']
      },
      scenario: {
        background: 'Testing bridge agent stats',
        challenges: [],
        successCriteria: []
      },
      agents: [
        {
          agentId: 'bridge-agent',
          principal: { 
            type: 'individual',
            name: 'Bridge Agent', 
            description: 'Bridges external clients' 
          },
          situation: 'Ready to bridge',
          systemPrompt: 'You bridge external clients',
          goals: ['Bridge messages'],
          tools: [],
          strategyType: 'bridge_to_external_mcp_server',
          strategyConfig: {
            bridgeServerUrl: 'https://example.com/mcp'
          }
        },
        {
          agentId: 'assistant',
          principal: { 
            type: 'individual',
            name: 'Assistant', 
            description: 'A helpful assistant' 
          },
          situation: 'Ready to help',
          systemPrompt: 'You are a helpful assistant',
          goals: ['Help users'],
          tools: [],
          strategyType: 'sequential_script',
          script: [
            { 
              trigger: { type: 'agent_turn', agentId: 'bridge-agent' },
              steps: [
                { type: 'thought', content: 'Thinking step 1' },
                { type: 'thought', content: 'Thinking step 2' },
                { type: 'thought', content: 'Thinking step 3' },
                { type: 'response', content: 'Test response from assistant' }
              ]
            }
          ]
        } as any
      ]
    };
    
    // Insert scenario into database
    const now = Date.now();
    orchestrator.getDbInstance().insertScenario({
      id: 'test-scenario',
      name: 'Bridge Stats Test',
      config: scenarioConfig,
      created: now,
      modified: now,
      history: []
    });
    
    // Convert to AgentConfig format for conversation creation
    const agentConfigs: AgentConfig[] = [
      {
        id: 'bridge-agent',
        strategyType: 'bridge_to_external_mcp_server',
        strategyConfig: {
          bridgeServerUrl: 'https://example.com/mcp'
        }
      },
      {
        id: 'assistant',
        strategyType: 'sequential_script',
        script: [
          { 
            trigger: { type: 'agent_turn', agentId: 'bridge-agent' },
            steps: [
              { type: 'thought', content: 'Thinking step 1' },
              { type: 'thought', content: 'Thinking step 2' },
              { type: 'thought', content: 'Thinking step 3' },
              { type: 'response', content: 'Test response from assistant' }
            ]
          }
        ]
      } as any
    ];
    
    // Create and start conversation
    const createResp = await orchestrator.createConversation({
      agents: agentConfigs,
      metadata: {
        scenarioId: 'test-scenario'
      }
    });
    
    const conversationId = createResp.conversation.id;
    await orchestrator.startConversation(conversationId);
    
    // Get the bridge agent instance
    const bridgeAgent = orchestrator.getAgentInstance(conversationId, 'bridge-agent') as BridgeAgent;
    expect(bridgeAgent).toBeDefined();
    expect(bridgeAgent).toBeInstanceOf(BridgeAgent);
    
    // Check initial stats
    let stats = bridgeAgent.getOtherAgentStats();
    expect(stats.otherAgentActions).toBe(0);
    expect(stats.agentId).toBeUndefined();
    
    // Have the bridge agent send a message (triggers assistant)
    const bridgePromise = bridgeAgent.bridgeExternalClientTurn(
      'Test message from external client',
      undefined,
      10000 // 10 second timeout
    );
    
    // Wait for assistant to process
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check stats during processing
    stats = bridgeAgent.getOtherAgentStats();
    expect(stats.otherAgentActions).toBeGreaterThan(0);
    expect(stats.agentId).toBe('assistant');
    expect(stats.lastActionType).toBeDefined();
    
    // Wait for the full reply
    const reply = await bridgePromise;
    expect(reply.reply).toBe('Test response from assistant');
    
    // Check final stats
    stats = bridgeAgent.getOtherAgentStats();
    expect(stats.otherAgentActions).toBe(3); // 3 thoughts from the assistant
    expect(stats.agentId).toBe('assistant');
    expect(stats.lastActionType).toBe('thought');
    expect(stats.lastActionAt).toBeDefined();
  });
  
  it('should accumulate stats across multiple interactions', async () => {
    // Create conversation where stats accumulate over time
    const agentConfigs: AgentConfig[] = [
      {
        id: 'bridge-agent',
        strategyType: 'bridge_to_external_mcp_server',
        strategyConfig: {
          bridgeServerUrl: 'https://example.com/mcp'
        }
      },
      {
        id: 'responsive-agent',
        strategyType: 'sequential_script',
        script: [
          { 
            trigger: { type: 'agent_turn', agentId: 'bridge-agent' },
            steps: [
              { type: 'thought', content: 'Processing input' },
              { type: 'response', content: 'Response ready' }
            ]
          }
        ]
      } as any
    ];
    
    // Create and start conversation
    const createResp = await orchestrator.createConversation({
      agents: agentConfigs,
      metadata: {}
    });
    
    const conversationId = createResp.conversation.id;
    await orchestrator.startConversation(conversationId);
    
    // Get the bridge agent
    const bridgeAgent = orchestrator.getAgentInstance(conversationId, 'bridge-agent') as BridgeAgent;
    expect(bridgeAgent).toBeDefined();
    
    // First message
    await bridgeAgent.bridgeExternalClientTurn('First message', undefined, 10000);
    
    // Check stats after first turn
    let stats = bridgeAgent.getOtherAgentStats();
    expect(stats.otherAgentActions).toBe(1); // 1 thought from first response
    expect(stats.agentId).toBe('responsive-agent');
    
    // Second message - stats should accumulate
    await bridgeAgent.bridgeExternalClientTurn('Second message', undefined, 10000);
    
    // Check stats after second turn - should accumulate
    stats = bridgeAgent.getOtherAgentStats();
    expect(stats.otherAgentActions).toBe(2); // 1 from first + 1 from second
    expect(stats.agentId).toBe('responsive-agent');
    
    // Third message
    await bridgeAgent.bridgeExternalClientTurn('Third message', undefined, 10000);
    
    // Final check
    stats = bridgeAgent.getOtherAgentStats();
    expect(stats.otherAgentActions).toBe(3); // Should keep accumulating
  });
  
  it('should only track actions from other agents, not self', async () => {
    // Create conversation with two bridge agents
    const agentConfigs: AgentConfig[] = [
      {
        id: 'bridge-agent-1',
        strategyType: 'bridge_to_external_mcp_server',
        strategyConfig: {
          bridgeServerUrl: 'https://example.com/mcp1'
        }
      },
      {
        id: 'bridge-agent-2',
        strategyType: 'bridge_to_external_mcp_server',
        strategyConfig: {
          bridgeServerUrl: 'https://example.com/mcp2'
        }
      }
    ];
    
    const createResp = await orchestrator.createConversation({
      agents: agentConfigs,
      metadata: {}
    });
    
    const conversationId = createResp.conversation.id;
    await orchestrator.startConversation(conversationId);
    
    // Get both bridge agents
    const bridgeAgent1 = orchestrator.getAgentInstance(conversationId, 'bridge-agent-1') as BridgeAgent;
    const bridgeAgent2 = orchestrator.getAgentInstance(conversationId, 'bridge-agent-2') as BridgeAgent;
    
    expect(bridgeAgent1).toBeDefined();
    expect(bridgeAgent2).toBeDefined();
    
    // Have bridge-agent-1 send a message
    const bridge1Promise = bridgeAgent1.bridgeExternalClientTurn(
      'Message from bridge 1',
      undefined,
      1000 // Short timeout since bridge-agent-2 won't respond
    );
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Check stats for both agents
    const stats1 = bridgeAgent1.getOtherAgentStats();
    const stats2 = bridgeAgent2.getOtherAgentStats();
    
    // bridge-agent-1 should have 0 actions (it sent the message, didn't track its own)
    expect(stats1.otherAgentActions).toBe(0);
    
    // bridge-agent-2 should have tracked bridge-agent-1's action
    expect(stats2.otherAgentActions).toBe(1);
    expect(stats2.agentId).toBe('bridge-agent-1');
    
    // Clean up - expect timeout
    try {
      await bridge1Promise;
    } catch (error: any) {
      expect(error.message).toContain('Timeout');
    }
  });
  
  it('should correctly track stats across agent lifecycle', async () => {
    // This test verifies stats tracking throughout the conversation
    const agentConfigs: AgentConfig[] = [
      {
        id: 'bridge-agent',
        strategyType: 'bridge_to_external_mcp_server',
        strategyConfig: {
          bridgeServerUrl: 'https://example.com/mcp'
        }
      },
      {
        id: 'verbose-agent',
        strategyType: 'sequential_script',
        script: [
          { 
            trigger: { type: 'agent_turn', agentId: 'bridge-agent' },
            steps: [
              { type: 'thought', content: 'First thought' },
              { type: 'thought', content: 'Second thought' },
              { type: 'thought', content: 'Third thought' },
              { type: 'thought', content: 'Fourth thought' },
              { type: 'thought', content: 'Fifth thought' },
              { type: 'response', content: 'Done thinking!' }
            ]
          }
        ]
      } as any
    ];
    
    const createResp = await orchestrator.createConversation({
      agents: agentConfigs,
      metadata: {}
    });
    
    const conversationId = createResp.conversation.id;
    await orchestrator.startConversation(conversationId);
    
    // Get the bridge agent
    const bridgeAgent = orchestrator.getAgentInstance(conversationId, 'bridge-agent') as BridgeAgent;
    expect(bridgeAgent).toBeDefined();
    
    // Initial stats should be zero
    let stats = bridgeAgent.getOtherAgentStats();
    expect(stats.otherAgentActions).toBe(0);
    
    // Send message and let verbose agent process
    const reply = await bridgeAgent.bridgeExternalClientTurn(
      'Test message',
      undefined,
      5000
    );
    
    // Should have received reply
    expect(reply.reply).toBe('Done thinking!');
    
    // Check final stats - should have tracked all 5 thoughts
    stats = bridgeAgent.getOtherAgentStats();
    expect(stats.otherAgentActions).toBe(5); // 5 thoughts from verbose-agent
    expect(stats.agentId).toBe('verbose-agent');
    expect(stats.lastActionType).toBe('thought');
  });
});