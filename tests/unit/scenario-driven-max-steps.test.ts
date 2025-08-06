import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { ScenarioDrivenAgent } from '$agents/scenario-driven.agent.js';
import { InProcessOrchestratorClient } from '$client/impl/in-process.client.js';
import { ConversationOrchestrator } from '$backend/core/orchestrator.js';
import { ToolSynthesisService } from '$agents/services/tool-synthesis.service.js';
import type { 
  ScenarioConfiguration, 
  LLMProvider, 
  LLMRequest,
  LLMResponse,
  ScenarioDrivenAgentConfig,
  ConversationTurn
} from '$lib/types.js';

describe('ScenarioDrivenAgent MAX_STEPS handling', () => {
  let mockLLMProvider: LLMProvider;
  let orchestrator: ConversationOrchestrator;
  let agent: ScenarioDrivenAgent;
  let llmCallCount = 0;
  let maxStepsHitCount = 0;
  let turnCompletedWithError = false;
  let originalConsoleError: typeof console.error;

  beforeEach(() => {
    llmCallCount = 0;
    maxStepsHitCount = 0;
    turnCompletedWithError = false;

    // Save the original console.error
    originalConsoleError = console.error;

    // Mock LLM that returns a tool call every time
    mockLLMProvider = {
      generateResponse: mock(async (request: LLMRequest): Promise<LLMResponse> => {
        llmCallCount++;
        // Always return a response that will consume a step
        return {
          content: `<scratchpad>
          I need to check something.
          </scratchpad>
          
          \`\`\`json
          {
            "name": "test_tool",
            "args": {"param": "value_${llmCallCount}"}
          }
          \`\`\``
        };
      }),
      getSupportedModels: () => ['test-model'],
      getDescription: () => 'Test LLM Provider'
    } as LLMProvider;

    // Track when max steps error occurs
    console.error = (...args: any[]) => {
      if (args[0] === "MAX STEPS reached, completing turn with error message") {
        maxStepsHitCount++;
      }
      originalConsoleError.apply(console, args);
    };
  });

  afterEach(() => {
    // Restore original console.error
    console.error = originalConsoleError;
  });

  test('should not repeatedly hit MAX_STEPS when called multiple times', async () => {
    const scenario: ScenarioConfiguration = {
      schemaVersion: '2.4',
      scenarioMetadata: {
        id: 'test-max-steps',
        version: '1.0.0',
        name: 'Max Steps Test',
        description: 'Test max steps handling'
      },
      patientAgent: {
        agentId: 'patient',
        principal: {
          id: 'patient-1',
          name: 'Test Patient',
          description: 'A test patient'
        },
        situation: 'Testing',
        systemPrompt: 'You are a patient',
        goals: ['Test the system'],
        tools: [{
          toolName: 'test_tool',
          description: 'A test tool',
          inputSchema: {
            type: 'object',
            properties: {
              param: { type: 'string' }
            }
          },
          synthesisGuidance: 'Return success'
        }],
        messageToUseWhenInitiatingConversation: 'Hello'
      },
      supplierAgent: {
        agentId: 'supplier',
        principal: {
          id: 'supplier-1',
          name: 'Test Supplier',
          description: 'A test supplier'
        },
        situation: 'Testing',
        systemPrompt: 'You are a supplier',
        goals: ['Respond to patient'],
        tools: [],
        messageToUseWhenInitiatingConversation: 'Hello from supplier'
      },
      interactionDynamics: {
        objective: 'Test max steps',
        conversationStyle: 'professional',
        expectedOutcome: 'Testing'
      },
      agents: []
    };

    // Add patient agent to agents array
    scenario.agents = [scenario.patientAgent];

    orchestrator = new ConversationOrchestrator(':memory:', mockLLMProvider);
    
    const toolSynthesis = new ToolSynthesisService(mockLLMProvider);
    toolSynthesis.execute = mock(async ({ toolName, args }) => ({
      output: { success: true, result: `Result for ${toolName}` }
    })) as any;

    const { conversation } = await orchestrator.createConversation({
      metadata: {
        scenarioId: 'test-max-steps',
        conversationTitle: 'Max Steps Test'
      },
      agents: [{
        id: 'patient',
        managementMode: 'internal'
      } as any]
    });

    const config: ScenarioDrivenAgentConfig = {
      id: 'patient',
      strategyType: 'scenario_driven',
      scenarioId: 'test-max-steps'
    };

    const client = new InProcessOrchestratorClient(orchestrator, 'patient');
    agent = new ScenarioDrivenAgent(config, client, scenario, mockLLMProvider, toolSynthesis);
    
    // Create a valid token for the agent
    const token = 'test-token-' + Date.now();
    orchestrator.getDbInstance().createAgentToken(token, conversation.id, 'patient');
    
    // Initialize the agent
    await agent.initialize(conversation.id, token);
    await client.authenticate(token);
    await client.subscribe(conversation.id);

    // Create a mock turn to trigger the agent
    const mockTurn: ConversationTurn = {
      id: 'turn-1',
      conversationId: conversation.id,
      agentId: 'other-agent',
      timestamp: new Date(),
      content: 'Please do something that requires many steps',
      status: 'completed',
      startedAt: new Date(),
      completedAt: new Date(),
      trace: []
    };

    // First call - should hit MAX_STEPS
    await agent.processAndReply(mockTurn);
    
    // Check that MAX_STEPS was hit
    expect(maxStepsHitCount).toBe(1);
    expect(llmCallCount).toBeGreaterThanOrEqual(10); // Should have made at least MAX_STEPS calls
    const firstCallCount = llmCallCount;
    
    // Simulate the agent being called again (which could happen if the orchestrator
    // triggers it again after the error)
    await agent.processAndReply(mockTurn);
    
    // Check that we don't hit MAX_STEPS again immediately
    // The agent should recognize it's in a bad state and not loop
    expect(maxStepsHitCount).toBe(1); // Should still be 1, not 2
    expect(llmCallCount).toBe(firstCallCount); // Should not have made more LLM calls
  }, 10000);

  test('should show critical warning at exactly step 10 (0 steps remaining)', async () => {
    let promptsWithCriticalWarning: string[] = [];
    let promptsWithoutCriticalWarning: string[] = [];
    
    // Mock LLM that tracks prompts
    mockLLMProvider = {
      generateResponse: mock(async (request: LLMRequest): Promise<LLMResponse> => {
        llmCallCount++;
        
        // Extract the prompt text from the request
        const promptText = request?.messages?.[0]?.content || '';
        
        // Check if the prompt contains the critical warning
        if (promptText.includes('CRITICAL_FINAL_STEP') || promptText.includes('0 STEPS REMAINING')) {
          promptsWithCriticalWarning.push(`Step ${llmCallCount}: Contains critical warning`);
        } else {
          promptsWithoutCriticalWarning.push(`Step ${llmCallCount}: No critical warning`);
        }
        
        // Always return a tool call to continue processing
        return {
          content: `<scratchpad>
          Processing step ${llmCallCount}.
          </scratchpad>
          
          \`\`\`json
          {
            "name": "process_tool",
            "args": {"step": ${llmCallCount}}
          }
          \`\`\``
        };
      }),
      getSupportedModels: () => ['test-model'],
      getDescription: () => 'Test LLM Provider'
    } as LLMProvider;

    const scenario: ScenarioConfiguration = {
      schemaVersion: '2.4',
      scenarioMetadata: {
        id: 'test-critical-warning',
        version: '1.0.0',
        name: 'Critical Warning Test',
        description: 'Test critical warning appears at step 10'
      },
      patientAgent: {
        agentId: 'patient',
        principal: {
          id: 'patient-1',
          name: 'Test Patient',
          description: 'A test patient'
        },
        situation: 'Testing critical warning',
        systemPrompt: 'You are testing the critical warning',
        goals: ['Test the critical warning at step 10'],
        tools: [{
          toolName: 'process_tool',
          description: 'A tool that processes',
          inputSchema: {
            type: 'object',
            properties: {
              step: { type: 'number' }
            }
          },
          synthesisGuidance: 'Return processing: true'
        }],
        messageToUseWhenInitiatingConversation: 'Start test'
      },
      supplierAgent: {
        agentId: 'supplier',
        principal: {
          id: 'supplier-1',
          name: 'Test Supplier',
          description: 'A test supplier'
        },
        situation: 'Testing',
        systemPrompt: 'You are a supplier',
        goals: ['Respond to patient'],
        tools: [],
        messageToUseWhenInitiatingConversation: 'Hello from supplier'
      },
      interactionDynamics: {
        objective: 'Test critical warning timing',
        conversationStyle: 'professional',
        expectedOutcome: 'Testing'
      },
      agents: []
    };

    scenario.agents = [scenario.patientAgent];

    orchestrator = new ConversationOrchestrator(':memory:', mockLLMProvider);
    
    const toolSynthesis = new ToolSynthesisService(mockLLMProvider);
    toolSynthesis.execute = mock(async () => ({
      output: { processing: true }
    })) as any;

    const { conversation } = await orchestrator.createConversation({
      metadata: {
        scenarioId: 'test-critical-warning',
        conversationTitle: 'Critical Warning Test'
      },
      agents: [{
        id: 'patient',
        managementMode: 'internal'
      } as any]
    });

    const config: ScenarioDrivenAgentConfig = {
      id: 'patient',
      strategyType: 'scenario_driven',
      scenarioId: 'test-critical-warning'
    };

    const client = new InProcessOrchestratorClient(orchestrator, 'patient');
    agent = new ScenarioDrivenAgent(config, client, scenario, mockLLMProvider, toolSynthesis);
    
    // Create a valid token for the agent
    const token = 'test-token-' + Date.now();
    orchestrator.getDbInstance().createAgentToken(token, conversation.id, 'patient');
    
    await agent.initialize(conversation.id, token);
    await client.authenticate(token);
    await client.subscribe(conversation.id);

    const mockTurn: ConversationTurn = {
      id: 'turn-1',
      conversationId: conversation.id,
      agentId: 'other-agent',
      timestamp: new Date(),
      content: 'Please process many steps',
      status: 'completed',
      startedAt: new Date(),
      completedAt: new Date(),
      trace: []
    };

    // Process and verify critical warning timing
    await agent.processAndReply(mockTurn);
    
    // Verify we made exactly 10 LLM calls
    expect(llmCallCount).toBe(10);
    
    // The critical warning should appear EXACTLY ONCE, only at step 10
    expect(promptsWithCriticalWarning.length).toBe(1);
    expect(promptsWithCriticalWarning[0]).toBe('Step 10: Contains critical warning');
    
    // Steps 1-9 should ALL be in the "without warning" list
    expect(promptsWithoutCriticalWarning.length).toBe(9);
    for (let i = 1; i <= 9; i++) {
      expect(promptsWithoutCriticalWarning.some(p => p === `Step ${i}: No critical warning`)).toBe(true);
    }
    
    // Step 10 should NOT be in the "without warning" list
    expect(promptsWithoutCriticalWarning.some(p => p.includes('Step 10'))).toBe(false);
  }, 10000);

  test('should complete turn with error when MAX_STEPS is reached', async () => {
    // Reset the mock to return a tool call every time for this test
    mockLLMProvider = {
      generateResponse: mock(async (request: LLMRequest): Promise<LLMResponse> => {
        llmCallCount++;
        return {
          content: `<scratchpad>
          Need more processing.
          </scratchpad>
          
          \`\`\`json
          {
            "name": "infinite_loop_tool",
            "args": {}
          }
          \`\`\``
        };
      }),
      getSupportedModels: () => ['test-model'],
      getDescription: () => 'Test LLM Provider'
    } as LLMProvider;
    
    const scenario: ScenarioConfiguration = {
      schemaVersion: '2.4',
      scenarioMetadata: {
        id: 'test-max-steps-2',
        version: '1.0.0',
        name: 'Max Steps Test 2',
        description: 'Test max steps error handling'
      },
      patientAgent: {
        agentId: 'patient',
        principal: {
          id: 'patient-1',
          name: 'Test Patient',
          description: 'A test patient'
        },
        situation: 'Testing',
        systemPrompt: 'You are a patient',
        goals: ['Test the system'],
        tools: [{
          toolName: 'infinite_loop_tool',
          description: 'A tool that always needs more processing',
          inputSchema: {
            type: 'object',
            properties: {}
          },
          synthesisGuidance: 'Return needs_more_processing: true'
        }],
        messageToUseWhenInitiatingConversation: 'Hello'
      },
      supplierAgent: {
        agentId: 'supplier',
        principal: {
          id: 'supplier-1',
          name: 'Test Supplier',
          description: 'A test supplier'
        },
        situation: 'Testing',
        systemPrompt: 'You are a supplier',
        goals: ['Respond to patient'],
        tools: [],
        messageToUseWhenInitiatingConversation: 'Hello from supplier'
      },
      interactionDynamics: {
        objective: 'Test max steps',
        conversationStyle: 'professional',
        expectedOutcome: 'Testing'
      },
      agents: []
    };

    scenario.agents = [scenario.patientAgent];

    orchestrator = new ConversationOrchestrator(':memory:', mockLLMProvider);
    
    const toolSynthesis = new ToolSynthesisService(mockLLMProvider);
    toolSynthesis.execute = mock(async () => ({
      output: { needs_more_processing: true }
    })) as any;

    const { conversation } = await orchestrator.createConversation({
      metadata: {
        scenarioId: 'test-max-steps-2',
        conversationTitle: 'Max Steps Test 2'
      },
      agents: [{
        id: 'patient',
        managementMode: 'internal'
      } as any]
    });

    const config: ScenarioDrivenAgentConfig = {
      id: 'patient',
      strategyType: 'scenario_driven',
      scenarioId: 'test-max-steps-2'
    };

    const client = new InProcessOrchestratorClient(orchestrator, 'patient');
    agent = new ScenarioDrivenAgent(config, client, scenario, mockLLMProvider, toolSynthesis);
    
    // Create a valid token for the agent
    const token = 'test-token-' + Date.now();
    orchestrator.getDbInstance().createAgentToken(token, conversation.id, 'patient');
    
    await agent.initialize(conversation.id, token);
    await client.authenticate(token);
    await client.subscribe(conversation.id);

    const mockTurn: ConversationTurn = {
      id: 'turn-1',
      conversationId: conversation.id,
      agentId: 'other-agent',
      timestamp: new Date(),
      content: 'Start processing',
      status: 'completed',
      startedAt: new Date(),
      completedAt: new Date(),
      trace: []
    };

    // Process and check that it completes with error
    await agent.processAndReply(mockTurn);
    
    // Get the conversation to check the last turn
    const conv = await orchestrator.getConversation(conversation.id);
    const lastTurn = conv.turns[conv.turns.length - 1];
    
    // The last turn should contain the max steps error
    expect(lastTurn.content).toContain('Max steps reached');
    expect(maxStepsHitCount).toBe(1);
  }, 10000);
});