import { Hono } from 'hono';
import { ScenarioBuilderLLM, getAvailableProviders } from '$llm/index.js';
import { LLMRequest, ApiResponse, LLMProvider } from '$lib/types.js';
import type { ConversationDatabase } from '$backend/db/database.js';

// The function now accepts the single, shared LLM provider instance.
export function createLLMRoutes(db: ConversationDatabase, llmProvider: LLMProvider): Hono {
  const router = new Hono();

// Helper to create API responses
function createResponse<T = any>(success: boolean, data?: T, error?: string): ApiResponse<T> {
  return {
    success,
    data,
    error,
    timestamp: new Date().toISOString()
  };
}

// POST /api/llm/generate - Completely managed by the server's LLM provider.
router.post('/generate', async (c) => {
  try {
    // The `apiKey` is no longer destructured from the request body.
    const { messages, model, temperature, maxTokens } = await c.req.json() as LLMRequest;

    if (!messages || !Array.isArray(messages)) {
      return c.json(createResponse(false, undefined, 'Messages array is required'), 400);
    }
    
    // --- REMOVED ---
    // The block that created a temporary provider with a client key is gone.
    // We now ALWAYS use the injected `llmProvider`.
    
    if (!(await llmProvider.isAvailable())) {
      return c.json(createResponse(false, undefined, 'The server\'s LLM provider is not configured.'), 400);
    }

    const response = await llmProvider.generateResponse({
      messages,
      model,
      temperature,
      maxTokens
    });
    
    return c.json(createResponse(true, response));
  } catch (error) {
    console.error('LLM generation error:', error);
    return c.json(createResponse(false, undefined, error instanceof Error ? error.message : 'LLM generation failed'), 500);
  }
});

// POST /api/llm/scenario-chat/:scenarioId - Also uses the server's provider.
router.post('/scenario-chat/:scenarioId', async (c) => {
  try {
    const scenarioId = c.req.param('scenarioId');
    // Request body is simpler, no apiKey.
    const { message, history = [] } = await c.req.json();
    
    if (!message || typeof message !== 'string') {
      return c.json(createResponse(false, undefined, 'Message string is required'), 400);
    }
    
    // Get the scenario from database
    const dbScenario = db.findScenarioById(scenarioId);
    if (!dbScenario) {
      return c.json(createResponse(false, undefined, 'Scenario not found'), 404);
    }
    
    // Get latest active version  
    const config = db.findScenarioByIdAndVersion(scenarioId);
    if (!config) {
      return c.json(createResponse(false, undefined, 'No active version found'), 404);
    }
    const scenario = {
      id: dbScenario.id,
      name: dbScenario.name,
      config,
      history: history, // Use provided chat history from frontend
      created: dbScenario.created,
      modified: dbScenario.modified
    };
    
    // Check the availability of the single, injected provider.
    if (!(await llmProvider.isAvailable())) {
      return c.json(createResponse(false, undefined, 'The server\'s LLM provider is not configured.'), 500);
    }
    
    // The ScenarioBuilderLLM is created with the application's default provider.
    const scenarioLLM = new ScenarioBuilderLLM(llmProvider);
    
    // Convert chat history to LLM format
    const conversationHistory = scenario.history.map((msg: any) => ({
      role: msg.role as 'user' | 'assistant',
      content: msg.content
    }));
    
    // Process the user message
    const result = await scenarioLLM.processUserMessage(
      message,
      scenario.config,
      conversationHistory
    );
    
    // Note: In the new database design, chat history is managed separately from scenarios
    // This endpoint returns the LLM response without persisting chat changes to maintain
    // separation between scenario definition and conversation history
    
    // Return the scenario with the response and any updates
    return c.json(createResponse(true, {
      scenario: scenario,
      assistantMessage: result.message,
      patches: result.patches || [],
      replaceEntireScenario: result.replaceEntireScenario,
      toolCalls: result.toolCalls || []
    }));
    
  } catch (error) {
    // Only log in non-test environment
    console.error('Scenario chat error:', error);
    return c.json(createResponse(false, undefined, error instanceof Error ? error.message : 'Scenario chat failed'), 500);
  }
});

// GET /api/llm/config - Reflects the server's configuration status.
router.get('/config', async (c) => {
  try {
    const providers = getAvailableProviders();
    // This check is now simpler and more direct.
    const isAvailable = await llmProvider.isAvailable();
    
    return c.json(createResponse(true, {
      serverApiKeyConfigured: isAvailable,
      providers,
      tools: [
        'send_message_to_user',
        'replace_scenario_entirely'
      ]
    }));
  } catch (error) {
    console.error('Config check error:', error);
    return c.json(createResponse(false, undefined, 'Failed to check configuration'), 500);
  }
});

  return router;
}