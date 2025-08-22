// src/agents/runtime/planner-agent.ts
import { BaseAgent, type TurnContext, type TurnRecoveryMode } from './base-agent';
import type { IAgentTransport } from './runtime.interfaces';
import type { ConversationSnapshot } from '$src/types/orchestrator.types';
import type { ScenarioConfiguration } from '$src/types/scenario-configuration.types';
import { ScenarioPlanner } from '$src/frontend/client/planner-scenario';
import { AttachmentVault, InMemoryStorageWrapper } from '$src/frontend/client/attachments-vault';
import type { LLMProvider } from '$src/types/llm.types';
import type { UnifiedEvent as StrictEvent } from '$src/frontend/client/types/events';
import { logLine } from '$src/lib/utils/logger';
import type { MessagePayload } from '$src/types/event.types';
import type { MessagePayload as PlannerMessagePayload } from '$src/frontend/client/types/events';
import { encodeTextToBase64, decodeBase64ToText } from '$src/lib/utils/xplat';

export interface PlannerAgentConfig {
  agentId: string;
  providerManager: any; // LLMProviderManager
  options?: {
    turnRecoveryMode?: TurnRecoveryMode;
    debugSink?: (lines: string[]) => void; // optional cross-runtime log sink
  };
}

export interface ToolRestriction {
  omitCoreTools?: string[];
  omitScenarioTools?: string[];
}

export interface EventTranslationMaps {
  supportedOrchestratorEventTypes: Set<string>;
  supportedPlannerEventTypes: Set<string>;
  orchestratorTraceToPlannerEvent: Record<string, string>;
  plannerEventToOrchestratorTrace: Record<string, string>;
}

export class PlannerAgent extends BaseAgent<ConversationSnapshot> {
  private providerManager: any;
  private attachmentVault: AttachmentVault;
  private toolRestrictions: ToolRestriction = { omitCoreTools: ['sendMessageToUser', 'done', 'sleep'] };
  private debugLog: string[] = [];
  private debugSink?: (lines: string[]) => void;

  constructor(transport: IAgentTransport, cfg: PlannerAgentConfig) {
    super(transport, cfg.options);
    this.providerManager = cfg.providerManager;
    this.attachmentVault = new AttachmentVault(new InMemoryStorageWrapper());
    this.debugSink = cfg.options?.debugSink;
  }

  private getEventTranslationMaps(): EventTranslationMaps {
    return {
      supportedOrchestratorEventTypes: new Set(['message', 'trace', 'system']),
      supportedPlannerEventTypes: new Set(['message', 'tool_call', 'tool_result', 'read_attachment', 'status', 'trace']),
      orchestratorTraceToPlannerEvent: {
        thought: 'trace',
        tool_call: 'tool_call',
        tool_result: 'tool_result'
      },
      plannerEventToOrchestratorTrace: {
        trace: 'thought',
        tool_call: 'tool_call',
        tool_result: 'tool_result'
        // status, read_attachment are handled specially (local-only or explicit pair)
      }
    };
  }

  protected async takeTurn(ctx: TurnContext<ConversationSnapshot>): Promise<void> {
    const { conversationId, agentId } = ctx;
    this.debugLog = [];
    this.addDebugLog(`=== Starting Turn ${ctx.currentTurnNumber} for Agent ${agentId} ===`);

    try {
      // 0) Populate vault from history (persisted attachments only)
      await this.populateAttachmentVaultFromHistory(ctx.snapshot);
      this.addDebugLog('Vault hydrated from orchestrator history');

      // 1) Convert snapshot → planner events (deterministic projection)
      const plannerEvents = this.convertSnapshotToPlannerEvents(ctx.snapshot, ctx.agentId);

      // 2) Extract scenario and instantiate planner
      const scenario = this.extractPlannerScenario(ctx.snapshot, ctx.agentId);
      const plannerInstance = new ScenarioPlanner({
        task: null,
        getPlannerAgentId: () => ctx.agentId,
        getCounterpartAgentId: () => this.getCounterpartAgentId(ctx),
        getAdditionalInstructions: () => undefined,
        getScenarioConfig: () => scenario,
        getLLMProvider: () => this.getLLMProvider(ctx),
        vault: this.attachmentVault,
        getToolRestrictions: () => this.toolRestrictions,
        onDebugPrompt: (p: string) => {
          this.addDebugLog(`LLM Prompt (${p.length} chars)`);
        }
      });

      // 3) Replay events and start
      plannerInstance.loadEvents(plannerEvents);
      plannerInstance.start();

      const unsubscribe = this.monitorPlannerEvents(ctx, plannerInstance);
      try {
        await this.waitForPlannerCompletion(plannerInstance);
      } finally {
        unsubscribe();
      }

      this.addDebugLog('=== Turn completed ===');
      this.writeDebugLog();
    } catch (error) {
      this.addDebugLog(`Turn error: ${String(error)}`);
      this.writeDebugLog();

      logLine(agentId, 'error', `PlannerAgent.takeTurn error: ${error}`);
      await ctx.transport.postMessage({
        conversationId,
        agentId,
        text: 'I encountered an unexpected error. Please try again later.',
        finality: 'turn',
        turn: ctx.currentTurnNumber || 0
      });
    }
  }

  private convertSnapshotToPlannerEvents(snapshot: ConversationSnapshot, myAgentId: string): StrictEvent[] {
    const out: StrictEvent[] = [];
    const sorted = [...snapshot.events].sort((a, b) => a.seq - b.seq);

    const pending: Record<string, { seq: number; timestamp: string; args: any; reasoning?: string }> = {};
    let lastThought: string | undefined;

    for (const e of sorted) {
      const ts = new Date(String(e.ts)).toISOString();

      if (e.type === 'message') {
        const author = e.agentId === myAgentId ? 'planner' : 'agent';
        out.push({
          seq: e.seq,
          timestamp: ts,
          type: 'message',
          channel: 'planner-agent',
          author,
          payload: { text: (e.payload as any).text }
        });
        continue;
      }

      if (e.type === 'trace' && e.agentId === myAgentId) {
        const t = e.payload as any;
        if (t.type === 'thought') {
          lastThought = String(t.content || '');
          out.push({
            seq: e.seq,
            timestamp: ts,
            type: 'trace',
            channel: 'system',
            author: 'system',
            payload: { text: lastThought }
          });
          continue;
        }
        if (t.type === 'tool_call') {
          const name = String(t.name || '');
          const args = t.args ?? {};
          const callId = String(t.toolCallId || `call_${e.seq}`);
          if (name === 'readAttachment') {
            pending[callId] = { seq: e.seq, timestamp: ts, args, reasoning: lastThought };
          } else {
            out.push({
              seq: e.seq,
              timestamp: ts,
              type: 'tool_call',
              channel: 'tool',
              author: 'planner',
              payload: { name, args },
              ...(lastThought ? { reasoning: lastThought } : {})
            });  
          }
          lastThought = undefined;
          continue;
        }
        if (t.type === 'tool_result') {
          const callId = String(t.toolCallId || '');
          const res = t.result;
          const pend = callId && pending[callId];
          if (pend) {
            const r = (res || {}) as any;
            out.push({
              seq: e.seq,
              timestamp: ts,
              type: 'read_attachment',
              channel: 'tool',
              author: 'planner',
              payload: {
                name: String(r.name || pend.args?.name || ''),
                ok: !!r.ok,
                size: typeof r.size === 'number' ? r.size : undefined,
                truncated: !!r.truncated,
                text_excerpt: typeof r.text_excerpt === 'string' ? r.text_excerpt : undefined
              },
              ...(pend.reasoning ? { reasoning: pend.reasoning } : {})
            });
            delete pending[callId];
          } else {
            out.push({
              seq: e.seq,
              timestamp: ts,
              type: 'tool_result',
              channel: 'tool',
              author: 'planner',
              payload: { result: res }
            });
          }
          continue;
        }
      }

      if (e.type === 'system') {
        out.push({
          seq: e.seq,
          timestamp: ts,
          type: 'trace',
          channel: 'system',
          author: 'system',
          payload: { text: `System: ${JSON.stringify(e.payload)}` }
        });
        continue;
      }
    }

    // add an input-rquired status
    out.push({
      seq: (out[out.length - 1]?.seq || 0) + 1,
      timestamp: new Date().toISOString(),
      type: 'status',
      channel: 'status',
      author: 'system',
      payload: { state: 'input-required' }
    });

    return out;
  }

  private extractPlannerScenario(snapshot: ConversationSnapshot, _myAgentId: string): ScenarioConfiguration | null {
    return snapshot.scenario || null;
  }

  private getLLMProvider(ctx: TurnContext<ConversationSnapshot>): LLMProvider {
    const runtimeAgent = ctx.snapshot.runtimeMeta?.agents?.find((a: any) => a.id === ctx.agentId);
    const model = (runtimeAgent?.config?.model as string) || undefined;
    return this.providerManager.getProvider({ model });
  }

  private getCounterpartAgentId(ctx: TurnContext<ConversationSnapshot>): string | undefined {
    if (!ctx.snapshot.scenario) return undefined;
    const others = ctx.snapshot.scenario.agents.filter(a => a.agentId !== ctx.agentId);
    return others[0]?.agentId;
  }

  private async populateAttachmentVaultFromHistory(snapshot: ConversationSnapshot): Promise<void> {
    for (const event of snapshot.events) {
      if (event.type !== 'message') continue;
      const payload = event.payload as MessagePayload;
      const attachments = payload.attachments || [];

      for (const att of attachments) {
        try {
          const name = String(att.name || '').trim();
          const docId = (att as any).docId || (att as any).id;
          const mime = String(att.contentType || 'text/plain');
          if (!name) continue;

          let content: string | null = null;
          if (this.transport && typeof this.transport.getAttachmentByDocId === 'function' && docId) {
            try {
              const row = await this.transport.getAttachmentByDocId({ conversationId: snapshot.conversation, docId });
              if (row && typeof row.content === 'string') content = row.content;
            } catch {}
          }
          if (!content && typeof (att as any).content === 'string') content = (att as any).content;
          if (typeof content !== 'string') continue;

          const b64 = encodeTextToBase64(content);
          this.attachmentVault.addFromAgent(name, mime, b64);
          this.addDebugLog(`Vault<-persisted: ${name} (${mime}) len=${content.length}`);
        } catch (error) {
          this.addDebugLog(`Vault ingest failed for attachment: ${String(error)}`);
        }
      }
    }
  }

  private monitorPlannerEvents(ctx: TurnContext<ConversationSnapshot>, planner: ScenarioPlanner) {
    return (planner as any).onEvent(async (event: StrictEvent) => {
      this.addDebugLog(`Planner event: ${event.type} ${event.channel}/${event.author}`);

      // 1) Message from planner → orchestrator message (resolve attachments from vault as text)
      if (event.type === 'message' && event.channel === 'planner-agent') {
        const payload = event.payload as PlannerMessagePayload; // NOTE: planner-side payload (with optional finality)
        const names = (payload.attachments || []).map(a => String(a.name)).filter(Boolean);

        const resolved: { name: string; contentType: string; content: string }[] = [];
        const missing: string[] = [];

        for (const name of names) {
          const rec = this.attachmentVault.getByName(name);
          if (!rec || !rec.bytes) { missing.push(name); continue; }
          const content = decodeBase64ToText(String(rec.bytes));
          const mime = String(rec.mimeType || 'text/plain');
          resolved.push({ name, contentType: mime, content });
        }

        if (missing.length) {
          this.addDebugLog(`Attachment resolution failed; missing=[${missing.join(', ')}]`);
          return; // Fail closed; let planner correct itself on next tick
        }

        // ⬇️ Respect planner-requested finality (conversation when terminal)
        const finality = payload.finality === 'conversation'
          ? 'conversation'
          : payload.finality === 'turn'
            ? 'turn'
            : 'turn';

        await ctx.transport.postMessage({
          conversationId: ctx.conversationId,
          agentId: ctx.agentId,
          text: payload.text,
          finality,
          attachments: resolved,
          turn: ctx.currentTurnNumber || 0
        });
        return;
      }

      // 2) Local-only events that must NOT be persisted directly
      if (event.type === 'status') return; // UI only

      // 3) read_attachment → persist as tool_call + tool_result for replayability
      if (event.type === 'read_attachment') {
        const p = event.payload as any;
        const toolCallId = `read_${Date.now()}_${Math.random().toString(36).slice(2)}`;

        await ctx.transport.postTrace({
          conversationId: ctx.conversationId,
          agentId: ctx.agentId,
          payload: { type: 'tool_call', name: 'readAttachment', args: { name: p.name }, toolCallId },
          turn: ctx.currentTurnNumber || 0
        });

        await ctx.transport.postTrace({
          conversationId: ctx.conversationId,
          agentId: ctx.agentId,
          payload: {
            type: 'tool_result',
            toolCallId,
            result: {
              name: p.name,
              ok: !!p.ok,
              size: typeof p.size === 'number' ? p.size : undefined,
              truncated: !!p.truncated,
              text_excerpt: typeof p.text_excerpt === 'string' ? p.text_excerpt : undefined
            }
          },
          turn: ctx.currentTurnNumber || 0
        });
        return;
      }

      // 4) Tool calls/results/thoughts → 1:1 traces
      if (event.type === 'tool_call' && event.reasoning) {
        await ctx.transport.postTrace({
          conversationId: ctx.conversationId,
          agentId: ctx.agentId,
          payload: { type: 'thought', content: event.reasoning },
          turn: ctx.currentTurnNumber || 0
        });
      }

      const mapped = this.translatePlannerEventToOrchestrator(event);
      if (!mapped) return;

      await ctx.transport.postTrace({
        conversationId: ctx.conversationId,
        agentId: ctx.agentId,
        payload: mapped as any,
        turn: ctx.currentTurnNumber || 0
      });
    });
  }

  private translatePlannerEventToOrchestrator(event: StrictEvent): any | null {
    const maps = this.getEventTranslationMaps();
    if (!maps.supportedPlannerEventTypes.has(event.type)) return null;

    switch (event.type) {
      case 'message':
      case 'status':
      case 'read_attachment':
        return null; // handled elsewhere or local-only

      case 'tool_call': {
        const p = event.payload as { name: string; args: any };
        return { type: 'tool_call', name: p.name, args: p.args, toolCallId: `call_${event.seq}` };
      }
      case 'tool_result': {
        const p = event.payload as { result: any };
        return { type: 'tool_result', toolCallId: `result_${event.seq}`, result: p.result };
      }
      case 'trace': {
        const p = event.payload as { text: string };
        return { type: 'thought', content: p.text };
      }
      default:
        return null;
    }
  }

  private async waitForPlannerCompletion(planner: ScenarioPlanner): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Planner timeout after 180 seconds')), 180000);
      let done = false;
      const off = (planner as any).onEvent((e: StrictEvent) => {
        if (done) return;
        if (e.type === 'message' && e.channel === 'planner-agent') {
          done = true;
          clearTimeout(timeout);
          off();
          try { (planner as any).stop(); } catch {}
          resolve();
        }
      });
    });
  }

  public setToolRestrictions(restrictions: ToolRestriction): void {
    this.toolRestrictions = restrictions;
  }

  private addDebugLog(entry: string): void {
    const ts = new Date().toISOString();
    this.debugLog.push(`[${ts}] ${entry}`);
  }

  private writeDebugLog(): void {
    try {
      if (this.debugSink) this.debugSink(this.debugLog);
      // Always mirror a short summary to console for both Bun and browser
      const tail = this.debugLog.slice(-5);
      if (tail.length) console.log('[PlannerAgent] log tail:', ...tail);
    } catch {}
  }
}
