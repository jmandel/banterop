import { describe, it, expect } from "bun:test";
import { App } from "$src/server/app";
import { createWebSocketServer, websocket } from "$src/server/ws/jsonrpc.server";
import { Hono } from "hono";
import type { ScenarioConfiguration } from "$src/types/scenario-configuration.types";
import { WsControl } from "$src/control/ws.control";

async function startServer(dbPath: string = ":memory:", skipAutoRun?: boolean): Promise<{ app: App; server: any; wsUrl: string }> {
  const app = new App({ dbPath, skipAutoRun: skipAutoRun ?? false });
  const hono = new Hono().route("/", createWebSocketServer(app.orchestrator, app.agentHost, app.lifecycleManager));
  const server = Bun.serve({ port: 0, fetch: hono.fetch, websocket });
  const wsUrl = `ws://localhost:${server.port}/api/ws`;
  return { app, server, wsUrl };
}

async function stopServer(server: any, app: App) {
  server.stop();
  await app.shutdown();
}

function createTestScenario(id: string): ScenarioConfiguration {
  const scenarioConfig: ScenarioConfiguration = {
    metadata: {
      id,
      title: `Test Scenario ${id}`,
      description: "Test scenario for auto-run feature",
      tags: ["test"]
    },
    scenario: {
      background: "This is a test conversation between two agents",
      challenges: ["Maintain conversation flow", "Complete turns properly"]
    },
    agents: [
      {
        agentId: "alpha",
        principal: {
          type: "individual",
          name: "Alpha",
          description: "Alpha test agent"
        },
        situation: "Starting a test conversation",
        systemPrompt: "You are Alpha. Reply briefly and complete your turns.",
        goals: ["Participate in the test conversation"],
        tools: [],
        knowledgeBase: {}
      },
      {
        agentId: "beta",
        principal: {
          type: "individual",
          name: "Beta",
          description: "Beta test agent"
        },
        situation: "Responding in a test conversation",
        systemPrompt: "You are Beta. Reply briefly and complete your turns.",
        goals: ["Participate in the test conversation"],
        tools: [],
        knowledgeBase: {}
      }
    ]
  };
  return scenarioConfig;
}

// Minimal JSON-RPC helper for tests
async function rpcCall<T = any>(wsUrl: string, method: string, params?: any): Promise<T> {
  const ws = new WebSocket(wsUrl);
  return new Promise<T>((resolve, reject) => {
    const id = crypto.randomUUID();
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.id !== id) return;
        ws.close();
        msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result as T);
      } catch (e) { ws.close(); reject(e); }
    };
    ws.onerror = reject;
  });
}

describe("Server runner registry + ensure", () => {
  it("persists ensure intent in runner_registry and allows stop", async () => {
    // === 1. Boot orchestrator ===
    const { app, server, wsUrl } = await startServer();

    // === 2. Create scenario ===
    // Seed scenario via in-process storage (REST exists but in-proc is simpler for test)
    app.orchestrator.storage.scenarios.insertScenario({
      id: "test-scenario-1",
      name: "Test Scenario 1",
      config: createTestScenario("test-scenario-1"),
      history: []
    });

    // === 3. Create conversation with scenario ===
    const { conversationId } = await rpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
      meta: {
        title: "Test AutoRun Flag",
        scenarioId: "test-scenario-1",
        agents: [ { id: "alpha" }, { id: "beta" } ]
      }
    });

    // === 4. Ensure agents on server – persists in runner_registry
    const ensured = await rpcCall<{ ensured: Array<{ id: string }> }>(wsUrl, "lifecycle.ensure", { conversationId, agentIds: ['alpha','beta'] });
    expect(ensured.ensured.length).toBeGreaterThan(0);

    // === 5. Stop and verify host stopped
    await rpcCall(wsUrl, "lifecycle.stop", { conversationId });
    const rowAfter = app.storage.db
      .prepare(`SELECT COUNT(1) as n FROM runner_registry WHERE conversation_id = ?`)
      .get(conversationId) as { n: number };
    expect(rowAfter.n).toBe(0);

    await stopServer(server, app);
  });

  it("resumes ensured agents on restart", async () => {
    // Use a temporary file for the database
    const tempDbPath = `/tmp/test-autorun-${Date.now()}.db`;
    
    // === 1. Boot orchestrator ===
    let { app, server, wsUrl } = await startServer(tempDbPath);

    // === 2. Create scenario ===
    app.orchestrator.storage.scenarios.insertScenario({ id: "test-scenario-2", name: "Test Scenario 2", config: createTestScenario("test-scenario-2"), history: [] });

    // === 3. Create conversation ===
    const { conversationId } = await rpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
      meta: {
        title: "Test Resume",
        scenarioId: "test-scenario-2",
        agents: [ { id: "alpha" }, { id: "beta" } ]
      }
    });

    // Mark for autoRun by ensuring server-managed agents
    await rpcCall(wsUrl, "lifecycle.ensure", { conversationId, agentIds: ['alpha','beta'] });

    // === 2. Shutdown ===
    await stopServer(server, app);

    // === 3. Restart orchestrator with same DB (enable autoRun for test) ===
    ({ app, server, wsUrl } = await startServer(tempDbPath, false));

    // Give it a moment to process resume logic
    await Bun.sleep(300);

    // === 4. AgentHost should list running agents for that conversation
    const running = app.agentHost.list(conversationId);
    expect(Array.isArray(running)).toBe(true);
    expect(running.length).toBeGreaterThan(0);

    await stopServer(server, app);
  });

// Note: autoRun flags removed in new design; runner_registry persists ensure intent server-locally.
});
