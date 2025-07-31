import type { ConversationDatabase } from '$backend/db/database.js';
import { ApiResponse, ScenarioListResponse, ScenarioResponse } from '$lib/types.js';
import { Hono } from 'hono';

export function createScenarioRoutes(db: ConversationDatabase): Hono {
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

// Helper to generate message ID
function createMessageId(): string {
  return `msg_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// GET /api/scenarios - List all scenarios
router.get('/', (c) => {
  try {
    const search = c.req.query('search');
    let dbScenarios;
    
    if (search && typeof search === 'string') {
      dbScenarios = db.searchScenarios(search);
    } else {
      dbScenarios = db.listScenarios();
    }

    // Convert database format to API format
    const scenarios = dbScenarios.map(dbScenario => {
      return {
        id: dbScenario.id,
        name: dbScenario.name,
        config: dbScenario.config,
        history: dbScenario.history, // Already available in ScenarioItem
        created: dbScenario.created,
        modified: dbScenario.modified
      };
    });

    const response = createResponse(true, {
      scenarios,
      total: scenarios.length
    }) as ScenarioListResponse;

    return c.json(response);
  } catch (error) {
    console.error('Error listing scenarios:', error);
    return c.json(createResponse(false, undefined, 'Failed to list scenarios'), 500);
  }
});

// GET /api/scenarios/:id - Get specific scenario
router.get('/:id', (c) => {
  try {
    const id = c.req.param('id');
    const dbScenario = db.findScenarioById(id);
    
    if (!dbScenario) {
      return c.json(createResponse(false, undefined, 'Scenario not found'), 404);
    }

    const scenario = {
      id: dbScenario.id,
      name: dbScenario.name,
      config: dbScenario.config,
      history: dbScenario.history,
      created: dbScenario.created,
      modified: dbScenario.modified
    };

    const response = createResponse(true, scenario) as ScenarioResponse;
    return c.json(response);
  } catch (error) {
    console.error('Error getting scenario:', error);
    return c.json(createResponse(false, undefined, 'Failed to get scenario'), 500);
  }
});

// POST /api/scenarios - Create new scenario
router.post('/', async (c) => {
  try {
    let body;
    try {
      body = await c.req.json() || {};
    } catch (error) {
      if (error instanceof SyntaxError || (error instanceof Error && error.message?.includes('JSON Parse error'))) {
        return c.json(createResponse(false, undefined, 'Invalid JSON in request body'), 400);
      }
      throw error;
    }
    const { name, config, history = [] } = body;
    
    if (!name || !config) {
      return c.json(createResponse(false, undefined, 'Name and config are required'), 400);
    }

    // Validate config has required structure
    if (!config.metadata || !config.scenario || !config.agents || !Array.isArray(config.agents)) {
      return c.json(createResponse(false, undefined, 'Invalid scenario configuration structure - must have metadata, scenario, and agents array'), 400);
    }

    // Generate unique ID for scenario
    const scenarioId = `scen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    
    // Create scenario using database method
    const scenarioItem = {
      id: scenarioId,
      name,
      config,
      history,
      created: now,
      modified: now
    };
    
    db.insertScenario(scenarioItem);
    
    // Return in expected format
    const scenario = scenarioItem;
    
    const response = createResponse(true, scenario) as ScenarioResponse;
    return c.json(response, 201);
  } catch (error) {
    console.error('Error creating scenario:', error);
    return c.json(createResponse(false, undefined, 'Failed to create scenario'), 500);
  }
});

// PUT /api/scenarios/:id - Update scenario metadata
router.put('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const updates = await c.req.json();
    
    const existing = db.findScenarioById(id);
    if (!existing) {
      return c.json(createResponse(false, undefined, 'Scenario not found'), 404);
    }

    // Update scenario metadata
    db.updateScenario(id, {
      name: updates.name,
      config: updates.config || existing.config // Keep existing config if not provided
    });

    // Get updated scenario
    const updatedScenario = db.findScenarioById(id);
    if (!updatedScenario) {
      return c.json(createResponse(false, undefined, 'Failed to update scenario'), 500);
    }
    
    const scenario = {
      id: updatedScenario.id,
      name: updatedScenario.name,
      config: updatedScenario.config,
      history: updatedScenario.history,
      created: updatedScenario.created,
      modified: updatedScenario.modified
    };

    const response = createResponse(true, scenario) as ScenarioResponse;
    return c.json(response);
  } catch (error) {
    console.error('Error updating scenario:', error);
    return c.json(createResponse(false, undefined, 'Failed to update scenario'), 500);
  }
});

// DELETE /api/scenarios/:id - Delete scenario
router.delete('/:id', (c) => {
  try {
    const id = c.req.param('id');
    
    const existing = db.findScenarioById(id);
    if (!existing) {
      return c.json(createResponse(false, undefined, 'Scenario not found'), 404);
    }

    db.deleteScenario(id);

    return c.json(createResponse(true, { id }));
  } catch (error) {
    console.error('Error deleting scenario:', error);
    return c.json(createResponse(false, undefined, 'Failed to delete scenario'), 500);
  }
});

// PUT /api/scenarios/:id/config - Create new scenario version (design-aligned)
router.put('/:id/config', async (c) => {
  try {
    const id = c.req.param('id');
    const config = await c.req.json();
    
    if (!config.metadata || !config.scenario || !config.agents || !Array.isArray(config.agents)) {
      return c.json(createResponse(false, undefined, 'Invalid scenario configuration structure - must have metadata, scenario, and agents array'), 400);
    }

    // Verify scenario exists
    const existing = db.findScenarioById(id);
    if (!existing) {
      return c.json(createResponse(false, undefined, 'Scenario not found'), 404);
    }

    // Update the scenario configuration
    db.updateScenario(id, {
      config: config
    });

    // Get updated scenario
    const updatedScenario = db.findScenarioById(id);
    if (!updatedScenario) {
      return c.json(createResponse(false, undefined, 'Failed to update scenario config'), 500);
    }

    // Return scenario with new config
    const scenario = {
      id: updatedScenario.id,
      name: updatedScenario.name,
      config: updatedScenario.config,
      history: updatedScenario.history,
      created: updatedScenario.created,
      modified: updatedScenario.modified
    };

    const response = createResponse(true, scenario) as ScenarioResponse;
    return c.json(response);
  } catch (error) {
    console.error('Error updating scenario config:', error);
    return c.json(createResponse(false, undefined, 'Failed to update scenario config'), 500);
  }
});

  return router;
}

// For backward compatibility, export a default that requires injection
export default function(db: ConversationDatabase) {
  return createScenarioRoutes(db);
}
