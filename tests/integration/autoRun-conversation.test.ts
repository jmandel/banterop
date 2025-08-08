import { describe, it, expect } from "bun:test";
import { App } from "$src/server/app";
import { createWebSocketServer, websocket } from "$src/server/ws/jsonrpc.server";
import { Hono } from "hono";
import { wsRpcCall } from "$src/cli/cli-utils/wsRpcCall";
import type { ScenarioConfiguration } from "$src/types/scenario-configuration.types";

async function startServer(dbPath: string = ":memory:", skipAutoRun?: boolean): Promise<{ app: App; server: any; wsUrl: string }> {
  const app = new App({ dbPath, skipAutoRun: skipAutoRun ?? false });
  const hono = new Hono().route("/", createWebSocketServer(app.orchestrator, app.providerManager));
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

describe("AutoRun conversation feature", () => {
  it("sets and clears autoRun flag correctly", async () => {
    // === 1. Boot orchestrator ===
    const { app, server, wsUrl } = await startServer();

    // === 2. Create scenario ===
    await wsRpcCall(wsUrl, "createScenario", {
      id: "test-scenario-1",
      name: "Test Scenario 1",
      config: createTestScenario("test-scenario-1")
    });

    // === 3. Create conversation with scenario ===
    const { conversationId } = await wsRpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
      meta: {
        title: "Test AutoRun Flag",
        scenarioId: "test-scenario-1",
        agents: [
          { id: "alpha", kind: "internal", agentClass: "ScenarioDrivenAgent" },
          { id: "beta", kind: "internal", agentClass: "ScenarioDrivenAgent" }
        ]
      }
    });

    // === 4. Trigger auto-run ===
    const runResp = await wsRpcCall<{ started: boolean }>(wsUrl, "runConversationToCompletion", { conversationId });
    expect(runResp.started).toBe(true);

    // === 5. Verify autoRun flag is set ===
    let convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBe(true);

    // === 6. Complete the conversation ===
    await wsRpcCall(wsUrl, "sendMessage", {
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
    await wsRpcCall(wsUrl, "createScenario", {
      id: "test-scenario-2",
      name: "Test Scenario 2",
      config: createTestScenario("test-scenario-2")
    });

    // === 3. Create conversation ===
    const { conversationId } = await wsRpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
      meta: {
        title: "Test Resume",
        scenarioId: "test-scenario-2",
        agents: [
          { id: "alpha", kind: "internal", agentClass: "ScenarioDrivenAgent" },
          { id: "beta", kind: "internal", agentClass: "ScenarioDrivenAgent" }
        ]
      }
    });

    // Mark for autoRun
    await wsRpcCall(wsUrl, "runConversationToCompletion", { conversationId });

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

  it("skips and clears autoRun for stale conversations on restart", async () => {
    // Use a temporary file for the database
    const tempDbPath = `/tmp/test-autorun-stale-${Date.now()}.db`;
    
    // === 1. Boot orchestrator ===
    let { app, server, wsUrl } = await startServer(tempDbPath);

    // === 2. Create scenario ===
    await wsRpcCall(wsUrl, "createScenario", {
      id: "test-scenario-3",
      name: "Test Scenario 3",
      config: createTestScenario("test-scenario-3")
    });

    // === 3. Create conversation ===
    const { conversationId } = await wsRpcCall<{ conversationId: number }>(wsUrl, "createConversation", {
      meta: {
        title: "Old AutoRun",
        scenarioId: "test-scenario-3",
        agents: [
          { id: "alpha", kind: "internal", agentClass: "ScenarioDrivenAgent" },
          { id: "beta", kind: "internal", agentClass: "ScenarioDrivenAgent" }
        ]
      }
    });

    // Trigger autoRun
    await wsRpcCall(wsUrl, "runConversationToCompletion", { conversationId });

    // Manually mark updated_at far older than cutoff
    // Need to drop the trigger to avoid auto-update of timestamp
    const oldTimestamp = new Date(Date.now() - (8 * 3600 * 1000)).toISOString(); // 8h ago
    
    // Disable the trigger (no need to recreate since DB is destroyed after test)
    app.storage.db.exec("DROP TRIGGER IF EXISTS trg_conversations_touch");
    
    // Now update with old timestamp
    app.storage.db.prepare(
      `UPDATE conversations SET updated_at = ?, meta_json = json_set(meta_json, '$.custom.autoRun', json('true')) WHERE conversation = ?`
    ).run(oldTimestamp, conversationId);

    // === 2. Shutdown before completion ===
    await stopServer(server, app);

    // === 3. Restart orchestrator with same DB (enable autoRun for test) ===
    ({ app, server, wsUrl } = await startServer(tempDbPath, false));

    // Give it a moment to process
    await Bun.sleep(100);

    // Flag should be cleared due to skip
    const convoMeta = app.orchestrator.getConversationWithMetadata(conversationId);
    expect(convoMeta?.metadata.custom?.autoRun).toBeFalsy();

    await stopServer(server, app);
  });
});