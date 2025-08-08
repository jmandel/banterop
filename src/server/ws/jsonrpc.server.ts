import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import type { WSContext } from 'hono/ws';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { UnifiedEvent } from '$src/types/event.types';
import type { JsonRpcRequest, JsonRpcResponse, SendMessageRequest, SendTraceRequest } from '$src/types/api.types';
import type { GuidanceEvent } from '$src/types/orchestrator.types';
import type { CreateConversationRequest } from '$src/types/conversation.meta';
import type { ListConversationsParams } from '$src/db/conversation.store';
import { startScenarioAgents } from '$src/agents/factories/scenario-agent.factory';
import type { ProviderManager } from '$src/llm/provider-manager';

const { upgradeWebSocket, websocket } = createBunWebSocket();

export function createWebSocketServer(orchestrator: OrchestratorService, providerManager?: ProviderManager) {
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
  if (/Turn already finalized/i.test(msg)) return { code: -32010, message: msg };
  if (/Conversation is finalized/i.test(msg) || /finalized/i.test(msg)) return { code: -32011, message: msg };
  if (/Only message events may set finality/i.test(msg)) return { code: -32013, message: msg };
  // Optionally detect idempotency duplicate if message text is added
  return { code: -32000, message: msg };
}

async function handleRpc(
  orchestrator: OrchestratorService,
  ws: { send: (data: string) => void },
  req: JsonRpcRequest,
  activeSubs: Set<string>,
  providerManager?: ProviderManager
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
      ws.send(JSON.stringify(ok(id, { conversationId })));
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

  if (method === 'getHydratedConversation') {
    const { conversationId } = params as { conversationId: number };
    try {
      const snap = orchestrator.getHydratedConversationSnapshot(conversationId);
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
    const { conversationId } = params as { conversationId: number };
    const snap = orchestrator.getConversationSnapshot(conversationId);
    ws.send(JSON.stringify(ok(id, snap)));
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
      
      // Start internal loops now if providerManager is available
      // Only start if there's a scenario or internal agents defined
      if (providerManager) {
        const hasInternalAgents = convo.metadata.agents?.some(a => a.kind === 'internal');
        if (convo.scenarioId || hasInternalAgents) {
          try {
            await startScenarioAgents(orchestrator, conversationId, {
              providerManager
            });
          } catch (err) {
            // Log but don't fail - agents might start on resume
            console.warn(`[AutoRun] Could not start agents immediately: ${err}`);
          }
        }
      }
      
      ws.send(JSON.stringify(ok(id, { started: true })));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
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