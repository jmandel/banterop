import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import type { WSContext } from 'hono/ws';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { UnifiedEvent } from '$src/types/event.types';
import type { JsonRpcRequest, JsonRpcResponse, SendMessageRequest, SendTraceRequest } from '$src/types/api.types';
import type { GuidanceEvent } from '$src/types/orchestrator.types';
import type { CreateConversationRequest } from '$src/types/conversation.meta';
import type { ListConversationsParams } from '$src/db/conversation.store';
import { startAgents } from '$src/agents/factories/agent.factory';
import { InProcessTransport } from '$src/agents/runtime/inprocess.transport';
import type { LLMProviderManager } from '$src/llm/provider-manager';

const { upgradeWebSocket, websocket } = createBunWebSocket();

export function createWebSocketServer(orchestrator: OrchestratorService, providerManager?: LLMProviderManager) {
  const app = new Hono();

  // Store subscription IDs per connection
  const connectionSubs = new WeakMap<WSContext, Set<string>>();

  app.get(
    '/api/ws',
    upgradeWebSocket(() => ({
      onOpen(_evt, ws) {
        connectionSubs.set(ws, new Set());
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'welcome', params: { ok: true } }));
      },
      async onMessage(evt, ws) {
        try {
          const req = JSON.parse(evt.data.toString()) as JsonRpcRequest;
          await handleRpc(orchestrator, ws, req, connectionSubs.get(ws) || new Set(), providerManager);
        } catch (err) {
          ws.send(JSON.stringify(errResp(null, -32700, 'Parse error')));
        }
      },
      onClose(_evt, ws) {
        // Cleanup subscriptions
        const subs = connectionSubs.get(ws);
        if (subs) {
          for (const subId of subs) {
            orchestrator.unsubscribe(subId);
          }
          connectionSubs.delete(ws);
        }
      },
    }))
  );

  return app;
}

function ok(id: string | number | null | undefined, result: unknown): JsonRpcResponse {
  return { id: id ?? null, result, jsonrpc: '2.0' };
}

function errResp(id: string | number | null | undefined, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { id: id ?? null, error: { code, message, data }, jsonrpc: '2.0' };
}

function mapError(e: unknown): { code: number; message: string } {
  const msg = e instanceof Error ? e.message : String(e);
  if (/Turn already open/i.test(msg)) return { code: -32010, message: msg };
  if (/Turn already finalized/i.test(msg)) return { code: -32010, message: msg };
  if (/Conversation is finalized/i.test(msg) || /finalized/i.test(msg)) return { code: -32011, message: msg };
  if (/Invalid turn number/i.test(msg)) return { code: -32012, message: msg };
  if (/Only message events may set finality/i.test(msg)) return { code: -32013, message: msg };
  // Optionally detect idempotency duplicate if message text is added
  return { code: -32000, message: msg };
}

async function handleRpc(
  orchestrator: OrchestratorService,
  ws: { send: (data: string) => void },
  req: JsonRpcRequest,
  activeSubs: Set<string>,
  providerManager?: LLMProviderManager
) {
  const { id = null, method, params = {} } = req;

  if (method === 'ping') {
    ws.send(JSON.stringify(ok(id, { ok: true, ts: new Date().toISOString() })));
    return;
  }

  if (method === 'createConversation') {
    try {
      const createParams = params as CreateConversationRequest;
      const conversationId = orchestrator.createConversation(createParams);
      ws.send(JSON.stringify(ok(id, { conversationId, title: createParams.meta?.title })));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'listConversations') {
    try {
      const listParams = params as ListConversationsParams;
      const conversations = orchestrator.listConversations(listParams);
      ws.send(JSON.stringify(ok(id, { conversations })));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'getConversationSnapshot') {
    const { conversationId } = params as { conversationId: number };
    try {
      const snap = orchestrator.getConversationSnapshot(conversationId, {
        includeScenario: true, // Always include scenario in snapshot
      });
      if (!snap) return ws.send(JSON.stringify(errResp(id, 404, 'Conversation not found')));
      ws.send(JSON.stringify(ok(id, snap)));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'getEventsPage') {
    const { conversationId, afterSeq, limit } = params as { conversationId: number; afterSeq?: number; limit?: number };
    try {
      const events = orchestrator.getEventsPage(conversationId, afterSeq, limit);
      const nextAfterSeq = events.length ? events[events.length - 1]!.seq : afterSeq;
      ws.send(JSON.stringify(ok(id, { events, nextAfterSeq })));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'subscribe') {
    const {
      conversationId,
      includeGuidance = false,
      filters,
      sinceSeq,
    } = params as {
      conversationId: number;
      includeGuidance?: boolean;
      filters?: { types?: Array<'message'|'trace'|'system'>; agents?: string[] };
      sinceSeq?: number;
    };
    const listener = (e: UnifiedEvent | GuidanceEvent) => {
      const methodName = 'type' in e && e.type === 'guidance' ? 'guidance' : 'event';
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: methodName, params: e }));
    };
    const subId = (filters?.types || filters?.agents)
      ? orchestrator.subscribeWithFilter(
          { conversation: conversationId, ...(filters?.types ? { types: filters.types } : {}), ...(filters?.agents ? { agents: filters.agents } : {}) },
          listener,
          includeGuidance
        )
      : orchestrator.subscribe(conversationId, listener, includeGuidance);
    activeSubs.add(subId);
    ws.send(JSON.stringify(ok(id, { subId })));

    if (typeof sinceSeq === 'number') {
      const backlog = orchestrator.getEventsSince(conversationId, sinceSeq);
      for (const ev of backlog) {
        // Apply the same filters to backlog replay as the subscription
        if (filters?.types && !filters.types.includes(ev.type)) continue;
        if (filters?.agents && !filters.agents.includes(ev.agentId)) continue;
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: ev }));
      }
    }
    return;
  }

  if (method === 'unsubscribe') {
    const { subId } = params as { subId: string };
    orchestrator.unsubscribe(subId);
    activeSubs.delete(subId);
    ws.send(JSON.stringify(ok(id, { ok: true })));
    return;
  }

  if (method === 'getConversation') {
    const { conversationId, includeScenario } = params as { conversationId: number; includeScenario?: boolean };
    const snap = orchestrator.getConversationSnapshot(conversationId, {includeScenario: includeScenario ?? true});
    ws.send(JSON.stringify(ok(id, snap)));
    return;
  }

  if (method === 'clearTurn') {
    const { conversationId, agentId } = params as { conversationId: number; agentId: string };
    try {
      const res = orchestrator.clearTurn(conversationId, agentId);
      ws.send(JSON.stringify(ok(id, res)));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'sendTrace') {
    const { conversationId, agentId, tracePayload, turn } = params as SendTraceRequest;
    try {
      const res = orchestrator.sendTrace(conversationId, agentId, tracePayload, turn);
      ws.send(JSON.stringify(ok(id, res)));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'sendMessage') {
    const { conversationId, agentId, messagePayload, finality, turn } = params as SendMessageRequest;
    try {
      const res = orchestrator.sendMessage(conversationId, agentId, messagePayload, finality, turn);
      ws.send(JSON.stringify(ok(id, res)));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }


  if (method === 'runConversationToCompletion') {
    const { conversationId } = params as { conversationId: number };
    try {
      const convo = orchestrator.getConversationWithMetadata(conversationId);
      if (!convo) {
        ws.send(JSON.stringify(errResp(id, 404, 'Conversation not found')));
        return;
      }
      if (convo.status !== 'active') {
        ws.send(JSON.stringify(errResp(id, 400, 'Conversation not active')));
        return;
      }
      
      // Mark autoRun = true in metadata
      convo.metadata.custom = { ...(convo.metadata.custom || {}), autoRun: true };
      orchestrator.storage.conversations.updateMeta(conversationId, convo.metadata);
      
      // Start agents now if providerManager is available
      // Location is a runtime decision, not based on 'kind'
      if (providerManager) {
        const hasAgents = convo.metadata.agents?.length > 0;
        console.log(`[AutoRun] hasAgents: ${hasAgents}, scenarioId: ${convo.metadata.scenarioId}`);
        if (hasAgents) {
          try {
            // Use the unified factory for all agents
            console.log(`[AutoRun] Starting agents for conversation ${conversationId}`);
            await startAgents({
              conversationId,
              transport: new InProcessTransport(orchestrator),
              providerManager
            });
            console.log(`[AutoRun] Agents started successfully for conversation ${conversationId}`);
          } catch (err) {
            // Log but don't fail - agents might start on resume
            console.warn(`[AutoRun] Could not start agents immediately: ${err}`);
          }
        }
      } else {
        console.log(`[AutoRun] No providerManager available`);
      }
      
      ws.send(JSON.stringify(ok(id, { started: true })));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  // Ensure agents running (new minimal API)
  if (method === 'ensureAgentsRunning') {
    const { conversationId, agentIds, providerConfig } = params as { 
      conversationId: number; 
      agentIds: string[];
      providerConfig?: unknown;
    };
    
    try {
      if (!providerManager) {
        throw new Error('Provider manager not available');
      }
      
      // Get conversation to verify it exists
      const snapshot = orchestrator.getConversationSnapshot(conversationId);
      if (!snapshot) {
        throw new Error(`Conversation ${conversationId} not found`);
      }
      
      // De-dupe agent IDs to avoid obvious duplicates
      const uniqueAgentIds = Array.from(new Set(agentIds));
      const ensured: Array<{ agentId: string; status: 'running' | 'starting' }> = [];
      
      // Start the requested agents using the factory
      console.log(`[ensureAgentsRunning] Ensuring agents ${uniqueAgentIds.join(', ')} for conversation ${conversationId}`);
      const handle = await startAgents({
        conversationId,
        transport: new InProcessTransport(orchestrator),
        providerManager,
        agentIds: uniqueAgentIds
      });
      
      // Build response with status for each agent
      for (const agentId of uniqueAgentIds) {
        ensured.push({ agentId, status: 'running' });
      }
      
      console.log(`[ensureAgentsRunning] Successfully ensured ${handle.agents.length} agents`);
      
      ws.send(JSON.stringify(ok(id, { ensured })));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  // Legacy startAgents method (kept for backward compatibility)
  if (method === 'startAgents') {
    // Redirect to ensureAgentsRunning
    const { conversationId, agentIds } = params as { conversationId: number; agentIds: string[] };
    req.method = 'ensureAgentsRunning';
    req.params = { conversationId, agentIds };
    return handleRpc(orchestrator, ws, req, activeSubs, providerManager);
  }

  if (method === 'subscribeAll') {
    const { includeGuidance = false } = params as { includeGuidance?: boolean };
    const subId = orchestrator.subscribeAll((e: UnifiedEvent | GuidanceEvent) => {
      const methodName = 'type' in e && e.type === 'guidance' ? 'guidance' : 'event';
      ws.send(JSON.stringify({ jsonrpc: '2.0', method: methodName, params: e }));
    }, includeGuidance);
    activeSubs.add(subId);
    ws.send(JSON.stringify(ok(id, { subId })));
    return;
  }

  // Scenario CRUD methods
  if (method === 'listScenarios') {
    try {
      const scenarios = orchestrator.storage.scenarios.listScenarios();
      ws.send(JSON.stringify(ok(id, { scenarios })));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'getScenario') {
    try {
      const { scenarioId } = params as { scenarioId: string };
      const item = orchestrator.storage.scenarios.findScenarioById(scenarioId);
      if (!item) {
        ws.send(JSON.stringify(errResp(id, 404, `Scenario '${scenarioId}' not found`)));
      } else {
        ws.send(JSON.stringify(ok(id, item)));
      }
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'createScenario') {
    try {
      const { id: scenarioId, name, config, history } = params as {
        id: string;
        name: string;
        config: import('$src/types/scenario-configuration.types').ScenarioConfiguration;
        history?: any[];
      };
      // minimal validation
      if (!scenarioId || !name || !config?.metadata?.id || config.metadata.id !== scenarioId) {
        ws.send(JSON.stringify(errResp(id, 400, 'id, name, and config.metadata.id (match) are required')));
        return;
      }
      const exists = orchestrator.storage.scenarios.findScenarioById(scenarioId);
      if (exists) {
        ws.send(JSON.stringify(errResp(id, 409, `Scenario '${scenarioId}' already exists`)));
        return;
      }
      orchestrator.storage.scenarios.insertScenario({ id: scenarioId, name, config, history: history ?? [] });
      const created = orchestrator.storage.scenarios.findScenarioById(scenarioId);
      ws.send(JSON.stringify(ok(id, created)));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'updateScenario') {
    try {
      const { id: scenarioId, name, config } = params as {
        id: string;
        name?: string;
        config?: import('$src/types/scenario-configuration.types').ScenarioConfiguration;
      };
      const exists = orchestrator.storage.scenarios.findScenarioById(scenarioId);
      if (!exists) {
        ws.send(JSON.stringify(errResp(id, 404, `Scenario '${scenarioId}' not found`)));
        return;
      }
      orchestrator.storage.scenarios.updateScenario(scenarioId, { 
        ...(name !== undefined ? { name } : {}), 
        ...(config !== undefined ? { config } : {}) 
      });
      const updated = orchestrator.storage.scenarios.findScenarioById(scenarioId);
      ws.send(JSON.stringify(ok(id, updated)));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'deleteScenario') {
    try {
      const { id: scenarioId } = params as { id: string };
      const exists = orchestrator.storage.scenarios.findScenarioById(scenarioId);
      if (!exists) {
        ws.send(JSON.stringify(errResp(id, 404, `Scenario '${scenarioId}' not found`)));
        return;
      }
      orchestrator.storage.scenarios.deleteScenario(scenarioId);
      ws.send(JSON.stringify(ok(id, { success: true })));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  ws.send(JSON.stringify(errResp(id, -32601, 'Method not found')));
}

export { websocket };