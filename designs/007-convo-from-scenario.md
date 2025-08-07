Of course. Here is a complete, self-contained development plan for implementing a flexible scenario and conversation management system. This plan assumes a developer is starting fresh on this feature and provides all necessary context, code, and validation steps.

---

### **Development Plan: Scenario-Driven Conversations**

#### **1. Project Goal & Core Architecture**

The goal is to enable the creation of conversations from pre-defined, reusable "scenario templates." This introduces a powerful and clean architectural separation:

*   **Scenario Templates (`ScenarioConfiguration`):** These are static, version-controlled definitions of an interaction's "world." They describe the roles, goals, available knowledge, and rules of engagement. They are stored in a central repository and do not change during a conversation.

*   **Conversation Instances:** A specific, live conversation is an *instantiation* of a scenario template. It simply **points** to the scenario by its ID. Crucially, it also stores any *runtime-specific* configuration (like which LLM model an agent should use for this specific run) that is provided when the conversation is created.

This design allows us to run the same scenario template in many different ways (e.g., with different AI models, with a human participant, with special instructions) without ever modifying the template itself.

#### **2. Key Concepts**

*   **`ScenarioConfiguration`:** The rich, detailed object defining the template. We will adopt this from the existing `v2` project assets.
*   **`Conversation`:** A record in our database that links to a `Scenario` and holds runtime-specific data.
*   **`HydratedConversationSnapshot`:** A complete, in-memory view of a live conversation, created on-demand by merging the static `ScenarioConfiguration` with the live `Conversation` data and its event log. This is the primary data structure that all system components will use to understand a conversation's context.

---

#### **3. Phase 1: Establish the Data Foundation**

We will define the database tables to store scenario templates and conversation instances.

**Action: Update the database schema.**
Modify `src/db/schema.sql.ts` to include a new `scenarios` table and refine the `conversations` table.

```ts
// src/db/schema.sql.ts

// ... (PRAGMA statements)

// Refined conversations table
CREATE TABLE IF NOT EXISTS conversations (
  conversation    INTEGER PRIMARY KEY,
  title           TEXT,
  description     TEXT,
  scenario_id     TEXT,                      -- POINTER to the scenarios table
  meta_json       TEXT NOT NULL DEFAULT '{}',  -- Stores ONLY runtime-specific data
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','completed')),
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_conversations_scenario ON conversations (scenario_id);

// NEW: Scenarios table to store templates
CREATE TABLE IF NOT EXISTS scenarios (
  id            TEXT PRIMARY KEY,      -- The unique scenarioId, e.g., "prior-auth.v2"
  name          TEXT NOT NULL,         -- A human-friendly name, e.g., "Prior Auth for Infliximab"
  config        TEXT NOT NULL,         -- The full ScenarioConfiguration as a JSON string
  history       TEXT NOT NULL DEFAULT '[]', -- Optional: chat history for a scenario builder UI
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  modified_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_scenarios_name ON scenarios (name);

// ... (rest of the schema: conversation_events, attachments, etc.)
```

---

#### **4. Phase 2: Integrate Core Data Types and Storage Logic**

We will bring in the `v2` type definitions and create the necessary data access layer.

**Action 1: Copy `v2` type definitions.**
*   Copy the file `../v2/src/types/scenario-configuration.types.ts` into our project at `src/types/scenario-configuration.types.ts`.
*   Update `src/types/index.ts` to export these new types: `export * from './scenario-configuration.types';`

**Action 2: Create a `ScenarioStore` for database access.**
This class will provide the CRUD methods needed by our API.

File: `src/db/scenario.store.ts` (New file)
```ts
import type { Database } from 'bun:sqlite';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';

export interface ScenarioItem {
  id: string;
  name: string;
  config: ScenarioConfiguration;
  history: any[];
  created: number;
  modified: number;
}

export class ScenarioStore {
  constructor(private db: Database) {}

  insertScenario(item: ScenarioItem): void {
    // ... (implementation from previous answer)
  }
  findScenarioById(id: string): ScenarioItem | null {
    // ... (implementation from previous answer)
  }
  listScenarios(): ScenarioItem[] {
    // ... (implementation from previous answer)
  }
  updateScenario(id: string, updates: Partial<Pick<ScenarioItem, 'name' | 'config'>>): void {
    // ... (implementation from previous answer)
  }
  deleteScenario(id: string): void {
    // ... (implementation from previous answer)
  }
}
```

**Action 3: Integrate `ScenarioStore` into the `Storage` facade.**
Modify `src/server/orchestrator/storage.ts` to include the new store.
```ts
// src/server/orchestrator/storage.ts
import { ScenarioStore } from '$src/db/scenario.store';

export class Storage {
  // ...
  scenarios!: ScenarioStore;

  constructor(dbPath: string = ':memory:') {
    // ...
    this.scenarios = new ScenarioStore(raw);
  }
  // ...
}
```

---

#### **5. Phase 3: Implement the API Endpoints**

We will create a full CRUD API for managing scenario templates and update the conversation creation endpoint.

**Action 1: Create and mount the `/api/scenarios` routes.**
*   Copy the file `../v2/src/backend/api/scenarios.ts` to `src/server/routes/scenarios.http.ts`.
*   Adjust the imports to match our project structure (e.g., `ConversationDatabase` becomes `ScenarioStore`).
*   In `src/server/index.ts`, mount these new routes, passing the `ScenarioStore` instance.

```ts
// src/server/index.ts
import { createScenarioRoutes } from './routes/scenarios.http';
// ...
server.route('/api/scenarios', createScenarioRoutes(appInstance.storage.scenarios));
```

**Action 2: Update the `POST /api/conversations` endpoint.**
This endpoint will now accept a `scenarioId` and runtime-specific data.

*   **Define the request body type:**
    File: `src/types/conversation.meta.ts`
    ```ts
    export interface AgentRuntimeConfig {
      id: string; // Must match an agentId from the scenario
      config: Record<string, unknown>;
    }

    export interface CreateConversationRequest {
      scenarioId: string;
      title?: string;
      description?: string;
      agents?: AgentRuntimeConfig[];
      custom?: Record<string, unknown>;
    }
    ```

*   **Implement the route logic:**
    File: `src/server/routes/conversations.http.ts` (Update `POST /api/conversations`)
    ```ts
    app.post('/api/conversations', async (c) => {
      const body = await c.req.json<CreateConversationRequest>();

      if (!body.scenarioId) {
        return c.json({ error: 'scenarioId is required' }, 400);
      }
      const scenario = orchestrator.storage.scenarios.findScenarioById(body.scenarioId);
      if (!scenario) {
        return c.json({ error: `Scenario '${body.scenarioId}' not found` }, 404);
      }

      // The `meta` object contains only runtime-specific data.
      const id = orchestrator.createConversation({
        scenarioId: body.scenarioId,
        title: body.title ?? scenario.config.metadata.title,
        description: body.description,
        meta: { agents: body.agents || [], custom: body.custom || {} }
      });

      const conversation = orchestrator.getConversationWithMetadata(id);
      return c.json(conversation, 201);
    });
    ```

---

#### **6. Phase 4: Implement the Hydration Logic**

This is the core of the feature: combining the static template with the live instance data.

**Action 1: Define the `HydratedConversationSnapshot` view model.**
File: `src/types/orchestrator.types.ts`
```ts
import type { ConversationMeta } from './conversation.meta';
import type { ScenarioConfiguration } from './scenario-configuration.types';
import type { UnifiedEvent } from './event.types';

export interface HydratedConversationSnapshot {
  conversation: number;
  status: 'active' | 'completed';
  scenario: ScenarioConfiguration | null;
  runtimeMeta: ConversationMeta;
  events: UnifiedEvent[];
}
```

**Action 2: Implement `getHydratedConversationSnapshot` in the Orchestrator.**
File: `src/server/orchestrator/orchestrator.ts` (New Method)
```ts
import { merge } from 'lodash-es'; // Add with `bun add lodash-es @types/lodash-es`

export class OrchestratorService {
  public readonly storage: Storage;
  // ...

  getHydratedConversationSnapshot(conversationId: number): HydratedConversationSnapshot | null {
    const convo = this.storage.conversations.getWithMetadata(conversationId);
    if (!convo) return null;

    const events = this.storage.events.getEvents(conversationId);
    let scenario: ScenarioConfiguration | null = null;
    if (convo.scenarioId) {
      const scenarioItem = this.storage.scenarios.findScenarioById(convo.scenarioId);
      scenario = scenarioItem?.config || null;
    }

    return {
      conversation: convo.conversation,
      status: convo.status as 'active' | 'completed',
      scenario,
      runtimeMeta: convo.metadata, // This is the lean runtime data
      events,
    };
  }
}
```

---

#### **7. Phase 5: Update the Scheduling Policy**

The policy engine must be updated to consume the new hydrated view.

**Action: Refactor the policy `decide` method.**
File: `src/server/orchestrator/policy.ts`
```ts
import type { HydratedConversationSnapshot } from '$src/types/orchestrator.types';

export class ScenarioPolicy implements SchedulePolicy {
  decide({ snapshot }: { snapshot: HydratedConversationSnapshot }): ScheduleDecision {
    if (!snapshot.scenario) {
      return { kind: 'none', note: 'Conversation is not linked to a scenario.' };
    }
    // Logic now reliably uses `snapshot.scenario.agents` and `snapshot.scenario.config`.
    // ...
  }
}
```
*The `OrchestratorService` must be updated to pass the hydrated snapshot to the policy.*

---

#### **8. Phase 6: End-to-End Validation Script**

Create a new CLI script to test and demonstrate the entire workflow.

**Action: Create `src/cli/run-sim-hydrated.ts`**
```ts
#!/usr/bin/env bun
import { App } from '$src/server/app';
import { Hono } from 'hono';
import { createConversationRoutes } from '$src/server/routes/conversations.http';
import { createScenarioRoutes } from '$src/server/routes/scenarios.http';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';

// Use the full infliximab scenario config from the v2 file asset
const infliximabScenario: ScenarioConfiguration = { /* ... paste full config ... */ };

async function main() {
  const appInstance = new App({ dbPath: ':memory:' });
  const server = new Hono()
    .route('/api/conversations', createConversationRoutes(appInstance.orchestrator))
    .route('/api/scenarios', createScenarioRoutes(appInstance.storage.scenarios));
  const bunServer = Bun.serve({ port: 0, fetch: server.fetch });
  console.log(`Server running on port ${bunServer.port}`);

  // STEP 1: Create the scenario template via the new API
  await fetch(`http://localhost:${bunServer.port}/api/scenarios`, {
    method: 'POST',
    body: JSON.stringify({ name: 'Infliximab PA Template', config: infliximabScenario }),
    headers: { 'Content-Type': 'application/json' },
  });
  console.log(`✅ Scenario template '${infliximabScenario.metadata.id}' created.`);

  // STEP 2: Create a conversation INSTANCE, providing RUNTIME-specific config
  const createRes = await fetch(`http://localhost:${bunServer.port}/api/conversations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      scenarioId: infliximabScenario.metadata.id,
      title: "PA for Sarah Jones (LLM: gpt-4o-mini)", // Runtime title
      agents: [
        { id: 'pa-reviewer-healthfirst', config: { model: 'gpt-4o-mini' } },
        { id: 'pa-specialist-rheum-clinic', config: { model: 'claude-3-haiku' } },
      ],
    }),
  });
  const convo = await createRes.json();
  const conversationId = convo.conversation;
  console.log(`✅ Conversation ${conversationId} instantiated from scenario.`);

  // STEP 3: Demonstrate hydration by fetching the merged view
  const hydrated = appInstance.orchestrator.getHydratedConversationSnapshot(conversationId);
  if (!hydrated) throw new Error("Hydration failed");

  const insurerAgentDef = hydrated.scenario!.agents.find(a => a.agentId === 'pa-reviewer-healthfirst')!;
  const insurerRuntimeConfig = hydrated.runtimeMeta.agents.find(a => a.id === 'pa-reviewer-healthfirst')!;

  console.log("\n--- Hydration Validation ---");
  console.log("Static goal from template:", insurerAgentDef.goals[0]);
  console.log("Runtime model from instance:", insurerRuntimeConfig.config.model);
  console.log("--------------------------\n");

  bunServer.stop(true);
  await appInstance.shutdown();
  console.log("🏁 Demo finished successfully.");
}

main().catch(console.error);
```
