// src/server/bridge/a2a-server.ts
import { streamSSE } from 'hono/streaming';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { ServerAgentLifecycleManager } from '$src/server/control/server-agent-lifecycle';
import type { UnifiedEvent } from '$src/types/event.types';
import {
  parseConversationMetaFromConfig64,
  getStartingAgentId,
} from '$src/server/bridge/conv-config.types';

type Deps = {
  orchestrator: OrchestratorService;
  lifecycle: ServerAgentLifecycleManager;
};

export class A2ABridgeServer {
  constructor(private deps: Deps, private config64: string) {}

  async handleJsonRpc(c: any, body: any) {
    const { id, method, params } = body || {};
    const ok = (result: any, status = 200) => c.json({ jsonrpc: '2.0', id, result }, status);
    const err = (code: number, message: string, status = 400) =>
      c.json({ jsonrpc: '2.0', id, error: { code, message } }, status);

    switch (method) {
      case 'message/send':
        try {
          return ok(await this.handleMessageSend(params));
        } catch (e: any) {
          return this.fail(c, id, e);
        }

      case 'message/stream':
        return this.handleMessageStream(c, params, id);

      case 'tasks/get':
        try {
          return ok(await this.handleTasksGet(params));
        } catch (e: any) {
          return this.fail(c, id, e);
        }

      case 'tasks/cancel':
        try {
          return ok(await this.handleTasksCancel(params));
        } catch (e: any) {
          return this.fail(c, id, e);
        }

      case 'tasks/resubscribe':
        return this.handleTasksResubscribe(c, params, id);

      default:
        return err(-32601, 'Method not found', 404);
    }
  }

  private fail(c: any, id: any, e: any) {
    const code = e?.rpc?.code ?? -32603;
    const message = e?.rpc?.message ?? e?.message ?? 'Internal error';
    return c.json({ jsonrpc: '2.0', id, error: { code, message } }, 500);
  }

  private rpcErr(code: number, message: string) {
    const e: any = new Error(message);
    e.rpc = { code, message };
    return e;
  }

  // --------- Handlers ----------

  private async handleMessageSend(params: any) {
    const { message } = params || {};
    const suppliedTaskId: string | undefined = message?.taskId ?? undefined;

    const { conversationId, externalId } = await this.ensureConversation(suppliedTaskId);
    await this.postExternalMessage(conversationId, externalId, message);
    return this.buildTask(conversationId, externalId);
  }

  private async handleMessageStream(c: any, params: any, rpcId: any) {
    const { message } = params || {};
    const suppliedTaskId: string | undefined = message?.taskId ?? undefined;
    
    console.log(`[A2A SSE] Starting message/stream for taskId: ${suppliedTaskId || 'new'}, rpcId: ${rpcId}`);

    const { conversationId, externalId } = await this.ensureConversation(suppliedTaskId);
    await this.postExternalMessage(conversationId, externalId, message);

    return await streamSSE(c, async (s: any) => {
      console.log(`[A2A SSE] Stream opened for conversation ${conversationId}`);
      let resolveDone: (() => void) | null = null;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      
      try {
        const initial = await this.buildTask(conversationId, externalId, 'submitted');
        await s.writeSSE({ data: JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: initial }) });
        try { await (s as any).flush?.(); } catch {}
      } catch (e: any) {
        console.error('Error sending initial frame:', e);
        await s.writeSSE({ data: JSON.stringify({ jsonrpc: '2.0', id: rpcId, error: { code: -32603, message: 'Stream initialization failed' } }) });
        (resolveDone as any)?.();
        return;
      }
      // No separate status-only frame; the Task snapshot already carries the current status.

      const subId = this.deps.orchestrator.subscribe(
        conversationId,
        async (evt: UnifiedEvent) => {
          try {
            const frames = await this.translateEvent(conversationId, externalId, evt);
            if (!frames) return;
            const arr = Array.isArray(frames) ? frames : [frames];
            console.log(`[A2A SSE] Sending ${arr.length} frame(s) for conversation ${conversationId}`);
            for (const frame of arr) {
              try {
                const frameData = JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: frame });
                console.log(`[A2A SSE] Writing frame: ${frame.kind || 'unknown'}, size: ${frameData.length} bytes`);
                await s.writeSSE({ data: frameData });
                await (s as any).flush?.();
              } catch (e: any) {
                console.error(`[A2A SSE] ERROR writing frame for conversation ${conversationId}:`, e);
                // Connection likely broken, clean up and exit
                clearInterval(keepAlive);
                try { this.deps.orchestrator.unsubscribe(subId); } catch {}
                try { await s.close(); } catch {}
                (resolveDone as any)?.();
                return;
              }
            }

            if (arr.some((f) => this.isTerminalFrame(f))) {
              console.log(`[A2A SSE] terminal frame detected, closing stream for conversation ${conversationId}`);
              try { await s.close(); } catch {}
              try { this.deps.orchestrator.unsubscribe(subId); } catch {}
              (resolveDone as any)?.();
            }
          } catch (e: any) {
            console.error(`[A2A SSE] ERROR processing event for conversation ${conversationId}:`, e);
            // Don't silently ignore - at least log the error
          }
        },
        true // includeGuidance snapshot
      );

      // Keep-alive ping to prevent connection timeout
      const keepAlive = setInterval(async () => {
        try {
          await s.writeSSE({ event: 'ping', data: 'keep-alive' });
          await (s as any).flush?.();
        } catch (e: any) {
          console.error('Keep-alive ping failed:', e);
          clearInterval(keepAlive);
          // Connection is broken, clean up
          try { this.deps.orchestrator.unsubscribe(subId); } catch {}
          try { await s.close(); } catch {}
          (resolveDone as any)?.();
        }
      }, 15000); // Send ping every 15 seconds

      const abortSignal: AbortSignal | undefined = (c as any)?.req?.raw?.signal || (c as any)?.req?.signal;
      if (abortSignal && typeof abortSignal.addEventListener === 'function') {
        abortSignal.addEventListener('abort', () => {
          clearInterval(keepAlive);
          try { this.deps.orchestrator.unsubscribe(subId); } catch {}
          (resolveDone as any)?.();
        });
      }
      
      try {
        await done; // keep stream open until terminal or abort
      } finally {
        clearInterval(keepAlive);
      }
    });
  }

  private async handleTasksGet(params: any) {
    const taskId = String(params?.id ?? '');
    const taskNum = Number(taskId);
    if (!Number.isFinite(taskNum) || taskNum <= 0 || !this.deps.orchestrator.getConversation(taskNum)) {
      throw this.rpcErr(-32001, 'Task not found');
    }
    const meta = parseConversationMetaFromConfig64(this.config64);
    const externalId = getStartingAgentId(meta);
    return this.buildTask(taskNum, externalId);
  }

  private async handleTasksCancel(params: any) {
    const taskId = String(params?.id ?? '');
    const taskNum = Number(taskId);
    if (!Number.isFinite(taskNum) || taskNum <= 0 || !this.deps.orchestrator.getConversation(taskNum)) {
      throw this.rpcErr(-32001, 'Task not found');
    }

    try {
      // Preferred helper
      await (this.deps.orchestrator as any).endConversation(taskNum, {
        authorId: 'system',
        text: 'Conversation canceled by client.',
        outcome: 'canceled',
      });
    } catch {
      // Fallback: write a terminal message directly
      try {
        this.deps.orchestrator.sendMessage(
          taskNum,
          'system',
          { text: 'Conversation canceled by client.', outcome: { status: 'canceled' } },
          'conversation'
        );
      } catch {
        throw this.rpcErr(
          -32004,
          'Cancellation not supported by underlying orchestrator yet'
        );
      }
    }

    try { await this.deps.lifecycle.stop(taskNum); } catch {}

    const meta = parseConversationMetaFromConfig64(this.config64);
    const externalId = getStartingAgentId(meta);
    return this.buildTask(taskNum, externalId, 'canceled');
  }

  private async handleTasksResubscribe(c: any, params: any, rpcId: any) {
    const taskId = String(params?.id ?? '');
    const taskNum = Number(taskId);
    if (!Number.isFinite(taskNum) || taskNum <= 0 || !this.deps.orchestrator.getConversation(taskNum)) {
      throw this.rpcErr(-32001, 'Task not found');
    }

    const meta = parseConversationMetaFromConfig64(this.config64);
    const externalId = getStartingAgentId(meta);

    return await streamSSE(c, async (s: any) => {
      let resolveDone: (() => void) | null = null;
      const done = new Promise<void>((resolve) => { resolveDone = resolve; });
      
      try {
        const initial = await this.buildTask(taskNum, externalId);
        await s.writeSSE({ data: JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: initial }) });
        try { await (s as any).flush?.(); } catch {}
      } catch (e: any) {
        console.error('Error sending initial resubscribe frame:', e);
        await s.writeSSE({ data: JSON.stringify({ jsonrpc: '2.0', id: rpcId, error: { code: -32603, message: 'Resubscribe initialization failed' } }) });
        (resolveDone as any)?.();
        return;
      }
      // No separate status-only frame; the Task snapshot already carries the current status.

      const subId = this.deps.orchestrator.subscribe(
        taskNum,
        async (evt: UnifiedEvent) => {
          try {
            const frames = await this.translateEvent(taskNum, externalId, evt);
            if (!frames) return;
            const arr = Array.isArray(frames) ? frames : [frames];
            for (const frame of arr) {
              try {
                await s.writeSSE({ data: JSON.stringify({ jsonrpc: '2.0', id: rpcId, result: frame }) });
                await (s as any).flush?.();
              } catch (e: any) {
                console.error('Error writing SSE frame in resubscribe:', e);
                // Connection likely broken, clean up and exit
                clearInterval(keepAlive);
                try { this.deps.orchestrator.unsubscribe(subId); } catch {}
                try { await s.close(); } catch {}
                (resolveDone as any)?.();
                return;
              }
            }
            if (arr.some((f) => this.isTerminalFrame(f))) {
              try { await s.close(); } catch {}
              try { this.deps.orchestrator.unsubscribe(subId); } catch {}
              (resolveDone as any)?.();
            }
          } catch (e: any) {
            console.error('Error processing resubscribe event:', e);
            // Don't silently ignore - at least log the error
          }
        },
        true
      );

      // Keep-alive ping to prevent connection timeout
      const keepAlive = setInterval(async () => {
        try {
          await s.writeSSE({ event: 'ping', data: 'keep-alive' });
          await (s as any).flush?.();
        } catch (e: any) {
          console.error('Keep-alive ping failed:', e);
          clearInterval(keepAlive);
          // Connection is broken, clean up
          try { this.deps.orchestrator.unsubscribe(subId); } catch {}
          try { await s.close(); } catch {}
          (resolveDone as any)?.();
        }
      }, 15000); // Send ping every 15 seconds

      const abortSignal2: AbortSignal | undefined = (c as any)?.req?.raw?.signal || (c as any)?.req?.signal;
      if (abortSignal2 && typeof abortSignal2.addEventListener === 'function') {
        abortSignal2.addEventListener('abort', () => {
          clearInterval(keepAlive);
          try { this.deps.orchestrator.unsubscribe(subId); } catch {}
          (resolveDone as any)?.();
        });
      }
      
      try {
        await done; // keep stream open until terminal or abort
      } finally {
        clearInterval(keepAlive);
      }
    });
  }

  // --------- Helpers ----------

  private async ensureConversation(suppliedTaskId?: string) {
    const meta = parseConversationMetaFromConfig64(this.config64);
    const externalId = getStartingAgentId(meta);

    if (suppliedTaskId) {
      const convId = Number(suppliedTaskId);
      if (!Number.isFinite(convId) || convId <= 0) throw this.rpcErr(-32001, 'Task not found');
      const conv = this.deps.orchestrator.getConversation(convId);
      if (!conv) throw this.rpcErr(-32001, 'Task not found');
      const status = this.deps.orchestrator.getConversationSnapshot(convId).status;
      if (status === 'completed') throw this.rpcErr(-32002, 'Task cannot be continued (terminal)');
      return { conversationId: convId, externalId };
    }

    // Create from ConversationMeta template
    const agents = meta.agents.map((a) => ({
      id: a.id,
      ...(a.agentClass !== undefined ? { agentClass: a.agentClass } : {}),
      // role, displayName, avatarUrl removed
      ...(a.config !== undefined ? { config: a.config } : {}),
    }));

    const conversationId = this.deps.orchestrator.createConversation({
      meta: {
        ...(meta.title !== undefined ? { title: meta.title } : {}),
        ...(meta.description !== undefined ? { description: meta.description } : {}),
        ...(meta.scenarioId !== undefined ? { scenarioId: meta.scenarioId } : {}),
        agents,
        ...(meta.config !== undefined ? { config: meta.config } : {}),
        custom: { ...(meta.custom ?? {}), bridge: 'a2a' },
      },
    });

    const internalIds = agents.map((a) => a.id).filter((id) => id !== externalId);
    if (internalIds.length) await this.deps.lifecycle.ensure(conversationId, internalIds);

    return { conversationId, externalId };
  }

  private async postExternalMessage(conversationId: number, externalId: string, a2aMsg: any) {
    const parts = Array.isArray(a2aMsg?.parts) ? a2aMsg.parts : [];
    const text = String(parts.find((p: any) => p?.kind === 'text')?.text ?? '');
    const atts = await this.persistUploads(parts);
    const clientRequestId = a2aMsg?.messageId || undefined;
    this.deps.orchestrator.sendMessage(
      conversationId,
      externalId,
      { text, ...(atts.length ? { attachments: atts } : {}), ...(clientRequestId ? { clientRequestId } : {}) },
      'turn'
    );
  }

  // Persist incoming FileParts (bytes/uri). For uri inputs you may choose to store references as-is.
  private async persistUploads(parts: any[]) {
    const out: any[] = [];
    for (const p of parts) {
      if (p?.kind !== 'file') continue;
      const f = p.file || {};
      const name = f.name || 'upload';
      const contentType = f.mimeType || 'application/octet-stream';
      if (f.bytes) {
        out.push({ name, contentType, content: f.bytes });
      } else if (f.uri) {
        // store reference or copy; for now, keep URI as content for later fetchers (optional)
        out.push({ name, contentType, content: f.uri });
      }
    }
    return out;
  }

  private async buildTask(conversationId: number, externalId: string, forceState?: any) {
    const snap = this.deps.orchestrator.getConversationSnapshot(conversationId, {
      includeScenario: false,
    });
    const id = String(conversationId);
    const state = forceState ?? this.deriveState(snap);
    const artifacts: any[] = [];
    const history = this.toA2aHistory(snap, externalId);

    return {
      id,
      contextId: id,
      status: { state },
      artifacts,
      history,
      kind: 'task',
      metadata: {},
    };
  }

  private deriveState(
    snap: any
  ): 'submitted' | 'working' | 'input-required' | 'completed' | 'failed' | 'canceled' {
    const evts = snap?.events || [];
    const lastMsg = [...evts].reverse().find((e: any) => e.type === 'message');
    if (!lastMsg) return 'submitted';
    if (lastMsg.finality === 'conversation') {
      const out = (lastMsg as any)?.payload?.outcome;
      if (typeof out === 'string') return out === 'canceled' ? 'canceled' : 'completed';
      const st = out?.status;
      return st === 'canceled' ? 'canceled' : st === 'errored' ? 'failed' : 'completed';
    }
    if (lastMsg.finality === 'turn') return 'input-required';
    return 'working';
  }

  private collectArtifacts(_snap: any) { return []; }

  private toA2aHistory(snap: any, externalId: string) {
    const evts = snap?.events || [];
    const convId = String(snap?.conversation ?? '');
    return evts
      .filter((e: any) => e.type === 'message')
      .map((e: any) => {
        const isExternal = e.agentId === externalId;
        const parts: any[] = [];
        const text = String(e?.payload?.text ?? '');
        if (text) parts.push({ kind: 'text', text });
        const atts = Array.isArray(e?.payload?.attachments) ? e.payload.attachments : [];
        for (const a of atts) {
          if (a?.id && a?.contentType) {
            const row = this.deps.orchestrator.getAttachment(a.id);
            const c = (row as any)?.content as string;
            const bytes = btoa(c);
            parts.push({ kind: 'file', file: { name: a.name ?? 'attachment', mimeType: a.contentType, bytes } });
          }
        }
        const clientReq = (e as any)?.payload?.clientRequestId as string | undefined;
        const outMsgId = isExternal && clientReq ? clientReq : String(e.event);
        return {
          role: isExternal ? 'user' : 'agent',
          parts,
          messageId: String(outMsgId),
          taskId: convId,
          contextId: convId,
          kind: 'message',
          metadata: {},
        };
      });
  }

  private async translateEvent(conversationId: number, externalId: string, evt: any): Promise<any | any[] | undefined> {
    // Message events ⇒ artifact updates; closing message ⇒ terminal status
    if (evt?.type === 'message') {
      const isExternal = evt.agentId === externalId;
      const frames: any[] = [];
      const text = String(evt?.payload?.text ?? '');
      const atts = Array.isArray(evt?.payload?.attachments) ? evt.payload.attachments : [];

      // For internal agent messages, emit a Message frame and, when appropriate, a StatusUpdate.
      if (!isExternal) {
        const parts: any[] = [];
        if (text) parts.push({ kind: 'text', text });
        for (const a of atts) {
          if (a?.id && a?.contentType) {
            const row = this.deps.orchestrator.getAttachment(a.id);
            const c = (row as any)?.content as string;
            const bytes = btoa(c);
            parts.push({ kind: 'file', file: { name: a.name ?? 'attachment', mimeType: a.contentType, bytes } });
          }
        }
        const outMsgId = String(evt.event);
        const messageObj = {
          role: 'agent',
          parts,
          messageId: String(outMsgId),
          taskId: String(conversationId),
          contextId: String(conversationId),
          kind: 'message',
          metadata: {},
        };

        // Emit the message itself
        frames.push(messageObj);

        // Then emit a status update if the message closed the turn or conversation
        if (evt.finality === 'turn') {
          // Reached a turn boundary: it's now the client's turn. Mark final:true and allow streams to close.
          frames.push({
            taskId: String(conversationId),
            contextId: String(conversationId),
            status: { state: 'input-required' },
            final: true,
            kind: 'status-update',
          });
        } else if (evt.finality === 'conversation') {
          const outcome = (evt as any)?.payload?.outcome;
          let state: 'completed' | 'canceled' | 'failed' = 'completed';
          if (typeof outcome === 'string') state = outcome === 'canceled' ? 'canceled' : 'completed';
          else if (outcome?.status === 'canceled') state = 'canceled';
          else if (outcome?.status === 'errored' || outcome?.status === 'failure') state = 'failed';
          frames.push({
            taskId: String(conversationId),
            contextId: String(conversationId),
            status: { state },
            final: true,
            kind: 'status-update',
          });
        }
      }

      return frames.length ? frames : undefined;
    }

    // Suppress separate guidance frames to avoid duplicate input-required notifications

    // Trace events from counterpart ⇒ emit incremental message content (no status update)
    if (evt?.type === 'trace' && evt?.agentId !== externalId) {
      const text = String(evt?.payload?.text ?? '');
      if (!text) return undefined;
      return {
        role: 'agent',
        parts: [{ kind: 'text', text }],
        messageId: String(evt.event ?? evt.seq ?? `${Date.now()}`),
        taskId: String(conversationId),
        contextId: String(conversationId),
        kind: 'message',
        metadata: {},
      };
    }
    return undefined;
  }

  private isTerminalFrame(frame: any) {
    const k = frame?.kind;
    if (k !== 'status-update') return false;
    // Treat any status-update with final:true as terminal (including input-required turn boundaries),
    // and also conversation terminal states for backward compatibility.
    if (frame?.final === true) return true;
    const st = frame?.status?.state;
    return st === 'completed' || st === 'failed' || st === 'canceled';
  }

  

}
