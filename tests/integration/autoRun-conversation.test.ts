import { describe, it, expect } from "bun:test";
import { App } from "$src/server/app";
import { createWebSocketServer, websocket } from "$src/server/ws/jsonrpc.server";
import { Hono } from "hono";
import type { ScenarioConfiguration } from "$src/types/scenario-configuration.types";
import { WsControl } from "$src/control/ws.control";

async function startServer(dbPath: string = ":memory:", skipAutoRun?: boolean): Promise<{ app: App; server: any; wsUrl: string }> {
  const app = new App({ dbPath, skipAutoRun: skipAutoRun ?? false });
  const hono = new Hono().route("/", createWebSocketServer(app.orchestrator, app.agentHost));
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

describe("AutoRun conversation feature", () => {
  it("sets and clears autoRun flag correctly", async () => {
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

    // === 4. Trigger auto-run ===
    // Ensure agents on server – sets autoRun in metadata
    const ensured = await rpcCall<{ ensured: Array<{ id: string }> }>(wsUrl, "ensureAgentsRunning", { conversationId });
    expect(ensured.ensured.length).toBeGreaterThan(0);

    // === 5. Verify autoRun flag is set ===
    let convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBe(true);

    // === 6. Complete the conversation ===
    await rpcCall(wsUrl, "sendMessage", {
      conversationId,
      agentId: "system",
      messagePayload: { text: "Conversation ended" },
      finality: "conversation"
    });

    // === 7. Verify autoRun flag is cleared after completion ===
    convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBeFalsy();

    await stopServer(server, app);
  });

  it("resumes active autoRun conversations on restart", async () => {
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
    await rpcCall(wsUrl, "ensureAgentsRunning", { conversationId });

    // Verify flag is set
    let convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBe(true);

    // === 2. Shutdown ===
    await stopServer(server, app);

    // === 3. Restart orchestrator with same DB (enable autoRun for test) ===
    ({ app, server, wsUrl } = await startServer(tempDbPath, false));

    // Give it a moment to process resume logic
    await Bun.sleep(100);

    // === 4. Flag should still be set for active conversation ===
    convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBe(true);

    await stopServer(server, app);
  });

  // Note: Stale autoRun clearing behavior removed in new design (simpler resume).
});
