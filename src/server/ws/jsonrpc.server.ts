import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import type { WSContext } from 'hono/ws';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { MessagePayload, TracePayload, Finality, UnifiedEvent } from '$src/types/event.types';
import type { JsonRpcRequest, JsonRpcResponse } from '$src/types/api.types';
import type { GuidanceEvent } from '$src/types/orchestrator.types';

const { upgradeWebSocket, websocket } = createBunWebSocket();

export function createWebSocketServer(orchestrator: OrchestratorService) {
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
          await handleRpc(orchestrator, ws, req, connectionSubs.get(ws) || new Set());
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

async function handleRpc(
  orchestrator: OrchestratorService,
  ws: { send: (data: string) => void },
  req: JsonRpcRequest,
  activeSubs: Set<string>
) {
  const { id = null, method, params = {} } = req;

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
    const { conversationId, agentId, tracePayload, turn } = params as {
      conversationId: number;
      agentId: string;
      tracePayload: TracePayload;
      turn?: number;
    };
    try {
      const res = orchestrator.sendTrace(conversationId, agentId, tracePayload, turn);
      ws.send(JSON.stringify(ok(id, res)));
    } catch (e) {
      const err = e as Error;
      ws.send(JSON.stringify(errResp(id, -32000, err.message)));
    }
    return;
  }

  if (method === 'sendMessage') {
    const { conversationId, agentId, messagePayload, finality, turn } = params as {
      conversationId: number;
      agentId: string;
      messagePayload: MessagePayload;
      finality: Finality;
      turn?: number;
    };
    try {
      const res = orchestrator.sendMessage(conversationId, agentId, messagePayload, finality, turn);
      ws.send(JSON.stringify(ok(id, res)));
    } catch (e) {
      const err = e as Error;
      ws.send(JSON.stringify(errResp(id, -32000, err.message)));
    }
    return;
  }

  if (method === 'claimTurn') {
    const { conversationId, agentId, guidanceSeq } = params as {
      conversationId: number;
      agentId: string;
      guidanceSeq: number;
    };
    try {
      const result = await orchestrator.claimTurn(conversationId, agentId, guidanceSeq);
      ws.send(JSON.stringify(ok(id, result)));
    } catch (e) {
      const err = e as Error;
      ws.send(JSON.stringify(errResp(id, -32000, err.message)));
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

  ws.send(JSON.stringify(errResp(id, -32601, 'Method not found')));
}

export { websocket };