import { Hono } from 'hono';
import { ScenarioBuilderLLM, getAvailableProviders } from '$llm/index.js';
import { LLMRequest, ApiResponse, LLMProvider } from '$lib/types.js';
import type { ConversationDatabase } from '$backend/db/database.js';
import { createLLMProvider } from '$llm/factory.js';

// The function now accepts the single, shared LLM provider instance.
export function createLLMRoutes(db: ConversationDatabase, llmProvider: LLMProvider): Hono {
  const router = new Hono();
  
  // Create provider instances for dynamic routing
  const providers: Record<string, LLMProvider | null> = {
    google: null,
    openrouter: null
  };
  
  // Initialize providers based on available API keys
  if (process.env.GEMINI_API_KEY) {
    providers.google = createLLMProvider({ provider: 'google', apiKey: process.env.GEMINI_API_KEY });
  }
  if (process.env.OPENROUTER_API_KEY) {
    providers.openrouter = createLLMProvider({ provider: 'openrouter', apiKey: process.env.OPENROUTER_API_KEY });
  }

// Helper to create API responses
function createResponse<T = any>(success: boolean, data?: T, error?: string): ApiResponse<T> {
  return {
    success,
    data,
    error,
    timestamp: new Date().toISOString()
  };
}

// POST /api/llm/generate - Dynamically routes to the appropriate provider based on model
router.post('/generate', async (c) => {
  try {
    const { messages, model, temperature, maxTokens } = await c.req.json() as LLMRequest;

    if (!messages || !Array.isArray(messages)) {
      return c.json(createResponse(false, undefined, 'Messages array is required'), 400);
    }

    // Determine which provider to use based on model name
    let selectedProvider: LLMProvider | null = null;
    
    // Check if model matches any provider's supported models
    if (providers.google && providers.google.getSupportedModels().includes(model || '')) {
      selectedProvider = providers.google;
    } else if (providers.openrouter && providers.openrouter.getSupportedModels().includes(model || '')) {
      selectedProvider = providers.openrouter;
    } else {
      // Default to the injected provider for backward compatibility
      selectedProvider = llmProvider;
      
      // If model was specified but not found in any provider, return error
      if (model && !selectedProvider.getSupportedModels().includes(model)) {
        return c.json(createResponse(false, undefined, `Model '${model}' not found in any configured provider`), 400);
      }
    }
    
    if (!selectedProvider) {
      return c.json(createResponse(false, undefined, 'No LLM provider configured'), 503);
    }

    const response = await selectedProvider.generateResponse({
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
    const availableProviders = getAvailableProviders();
    
    // Filter to only show providers that are actually configured
    const configuredProviders = availableProviders.filter(p => {
      if (p.name === 'google' && providers.google) return true;
      if (p.name === 'openrouter' && providers.openrouter) return true;
      return false;
    });
    
    return c.json(createResponse(true, {
      providers: configuredProviders,
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