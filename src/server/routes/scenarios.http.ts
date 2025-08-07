import { Hono } from 'hono';
import type { ScenarioStore } from '$src/db/scenario.store';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';

export function createScenarioRoutes(scenarioStore: ScenarioStore) {
  const app = new Hono();

  // List all scenarios
  app.get('/', (c) => {
    const scenarios = scenarioStore.listScenarios();
    return c.json(scenarios);
  });

  // Get a specific scenario by ID
  app.get('/:id', (c) => {
    const id = c.req.param('id');
    const scenario = scenarioStore.findScenarioById(id);
    
    if (!scenario) {
      return c.json({ error: `Scenario '${id}' not found` }, 404);
    }
    
    return c.json(scenario);
  });

  // Create a new scenario
  app.post('/', async (c) => {
    const body = await c.req.json() as {
      name: string;
      config: ScenarioConfiguration;
      history?: any[];
    };
    
    if (!body.name || !body.config) {
      return c.json({ error: 'name and config are required' }, 400);
    }
    
    if (!body.config.metadata?.id) {
      return c.json({ error: 'config.metadata.id is required' }, 400);
    }
    
    // Check if scenario with this ID already exists
    const existing = scenarioStore.findScenarioById(body.config.metadata.id);
    if (existing) {
      return c.json({ error: `Scenario with id '${body.config.metadata.id}' already exists` }, 409);
    }
    
    scenarioStore.insertScenario({
      id: body.config.metadata.id,
      name: body.name,
      config: body.config,
      history: body.history || [],
    });
    
    const created = scenarioStore.findScenarioById(body.config.metadata.id);
    return c.json(created, 201);
  });

  // Update a scenario
  app.put('/:id', async (c) => {
    const id = c.req.param('id');
    const body = await c.req.json() as {
      name?: string;
      config?: ScenarioConfiguration;
    };
    
    const existing = scenarioStore.findScenarioById(id);
    if (!existing) {
      return c.json({ error: `Scenario '${id}' not found` }, 404);
    }
    
    scenarioStore.updateScenario(id, body);
    const updated = scenarioStore.findScenarioById(id);
    return c.json(updated);
  });

  // Delete a scenario
  app.delete('/:id', (c) => {
    const id = c.req.param('id');
    
    const existing = scenarioStore.findScenarioById(id);
    if (!existing) {
      return c.json({ error: `Scenario '${id}' not found` }, 404);
    }
    
    scenarioStore.deleteScenario(id);
    return c.json({ success: true, deleted: id });
  });

  return app;
}