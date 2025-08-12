import { Hono } from 'hono';
import { createBunWebSocket } from 'hono/bun';
import type { WSContext } from 'hono/ws';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { UnifiedEvent } from '$src/types/event.types';
import type { GuidanceEvent } from '$src/types/orchestrator.types';
import type { JsonRpcRequest, JsonRpcResponse, SendMessageRequest, SendTraceRequest } from '$src/types/api.types';
import type { CreateConversationRequest } from '$src/types/conversation.meta';
import { AgentHost } from '$src/server/agent-host';
import { RunnerRegistry } from '$src/server/runner-registry';

const { upgradeWebSocket, websocket } = createBunWebSocket();

export function createWebSocketServer(orchestrator: OrchestratorService, agentHost: AgentHost) {
  const app = new Hono();
  const registry = new RunnerRegistry(orchestrator.storage.db, agentHost);

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
          await handleRpc(orchestrator, agentHost, registry, ws, req, connectionSubs.get(ws) || new Set());
        } catch {
          ws.send(JSON.stringify(errResp(null, -32700, 'Parse error')));
        }
      },
      onClose(_evt, ws) {
        const subs = connectionSubs.get(ws);
        if (subs) {
          for (const subId of subs) orchestrator.unsubscribe(subId);
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
  return { code: -32000, message: msg };
}

async function handleRpc(
  orchestrator: OrchestratorService,
  agentHost: AgentHost,
  registry: RunnerRegistry,
  ws: { send: (data: string) => void },
  req: JsonRpcRequest,
  activeSubs: Set<string>
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

  if (method === 'getConversation') {
    const { conversationId, includeScenario } = params as { conversationId: number; includeScenario?: boolean };
    const snap = orchestrator.getConversationSnapshot(conversationId, { includeScenario: includeScenario ?? true });
    ws.send(JSON.stringify(ok(id, snap)));
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
    const { conversationId, includeGuidance = false, filters, sinceSeq } = params as {
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
        if (filters?.types && !filters.types.includes(ev.type)) continue;
        if (filters?.agents && !filters.agents.includes(ev.agentId)) continue;
        ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'event', params: ev }));
      }
    }
    // Emit initial guidance snapshot (event-driven guidance with better pull semantics)
    if (includeGuidance) {
      try {
        const snap = orchestrator.getConversationSnapshot(conversationId);
        if (snap?.status !== 'completed') {
          const msgs = (snap?.events || []).filter((e) => e.type === 'message');
          if (msgs.length === 0) {
            const startId = (snap as any)?.metadata?.startingAgentId as string | undefined;
            if (startId) {
              const g = { type: 'guidance', conversation: conversationId, nextAgentId: startId, seq: 0.1, kind: 'start_turn' as const, deadlineMs: Date.now() + 30000, turn: 1 };
              ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'guidance', params: g }));
            }
          } else {
            const last = msgs[msgs.length - 1]!;
            if (last.finality === 'turn') {
              const ids = ((snap as any)?.metadata?.agents || []).map((a: any) => a.id) as string[];
              const idx = ids.indexOf(last.agentId ?? '');
              const nextId = ids.length > 0 ? ids[(idx + 1 + ids.length) % ids.length] : undefined;
              if (nextId && nextId !== last.agentId) {
                const g = { type: 'guidance', conversation: conversationId, nextAgentId: nextId, seq: (last.seq ?? 0) + 0.1, kind: 'start_turn' as const, deadlineMs: Date.now() + 30000, turn: (last.turn ?? 0) + 1 };
                ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'guidance', params: g }));
              }
            } else {
              // Last message did not close a turn; assume current turn open, owned by last non-system event's agent
              let owner: string | undefined;
              for (let i = (snap.events || []).length - 1; i >= 0; i--) {
                const e = (snap.events as any[])[i];
                if (e.turn === last.turn && e.type !== 'system') { owner = e.agentId; break; }
              }
              if (owner) {
                const g = { type: 'guidance', conversation: conversationId, nextAgentId: owner, seq: (last.seq ?? 0) + 0.1, kind: 'continue_turn' as const, deadlineMs: Date.now() + 30000, turn: last.turn };
                ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'guidance', params: g }));
              }
            }
          }
        }
      } catch (e) {
        // best-effort; ignore errors
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

  // Subscribe to new conversation creations across all conversations
  if (method === 'subscribeConversations') {
    const includeGuidance = false;
    const subId = orchestrator.subscribeAll((e: UnifiedEvent | GuidanceEvent) => {
      if ('type' in e) {
        if (e.type === 'system') {
          const payload: any = (e as any).payload;
          if (payload && payload.kind === 'meta_created') {
            ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'conversation', params: { conversationId: e.conversation } }));
          }
        } else if (e.type === 'message') {
          const m = e as UnifiedEvent;
          // Notify list watchers quickly when a conversation completes
          if (m.finality === 'conversation') {
            ws.send(JSON.stringify({ jsonrpc: '2.0', method: 'conversation', params: { conversationId: m.conversation } }));
          }
        }
      }
    }, includeGuidance);
    activeSubs.add(subId);
    ws.send(JSON.stringify(ok(id, { subId })));
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

  if (method === 'ensureAgentsRunningOnServer') {
    const { conversationId, agentIds = [] } = params as { conversationId: number; agentIds?: string[] };
    try {
      console.log('[ws] ensureAgentsRunningOnServer called', { conversationId, agentIdsCount: agentIds.length, agentIds });
      const snapshot = orchestrator.getConversationSnapshot(conversationId);
      if (!snapshot) throw new Error(`Conversation ${conversationId} not found`);
      const res = await registry.ensureAgentsRunningOnServer(conversationId, agentIds);
      console.log('[ws] ensureAgentsRunningOnServer success', { conversationId, ensured: res.ensured.map(e => e.id) });
      ws.send(JSON.stringify(ok(id, res)));
    } catch (e) {
      console.error('[ws] ensureAgentsRunningOnServer error', e);
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  if (method === 'stopAgentsOnServer') {
    const { conversationId, agentIds } = params as { conversationId: number; agentIds?: string[] };
    try {
      const res = await registry.stopAgentsOnServer(conversationId, agentIds);
      ws.send(JSON.stringify(ok(id, res)));
    } catch (e) {
      const { code, message } = mapError(e);
      ws.send(JSON.stringify(errResp(id, code, message)));
    }
    return;
  }

  ws.send(JSON.stringify(errResp(id, -32601, 'Method not found')));
}

export { websocket };
