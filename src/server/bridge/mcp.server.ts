import type {
  BeginChatThreadRequest, BeginChatThreadResponse,
  PostMessageRequest, PostMessageResponse,
  WaitForUpdatesRequest, WaitForUpdatesResponse,
  PublicMessage
} from './mcp.contract';
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { UnifiedEvent, MessagePayload } from '$src/types/event.types';

export class MCPBridge {
  constructor(private orch: OrchestratorService) {}

  begin_chat_thread(req: BeginChatThreadRequest): BeginChatThreadResponse {
    const params: Parameters<typeof this.orch.createConversation>[0] = {};
    if (req.title !== undefined) params.title = req.title;
    if (req.description !== undefined) params.description = req.description;
    
    const id = this.orch.createConversation(params);
    const snap = this.orch.getConversationSnapshot(id);
    const latestSeq = snap.events.length ? snap.events[snap.events.length - 1]!.seq : 0;
    return { 
      conversationId: id, 
      latestSeq, 
      status: snap.status 
    };
  }

  post_message(req: PostMessageRequest): PostMessageResponse {
    const finality = req.finality ?? 'turn';
    const payload: MessagePayload = {
      text: req.text,
    };
    if (req.attachments !== undefined) payload.attachments = req.attachments;
    if (req.clientRequestId !== undefined) payload.clientRequestId = req.clientRequestId;
    
    const res = this.orch.appendEvent({
      conversation: req.conversationId,
      type: 'message',
      payload,
      finality,
      agentId: 'external-mcp',
    });
    
    return { 
      conversationId: res.conversation, 
      turn: res.turn, 
      event: res.event, 
      seq: res.seq, 
      ts: res.ts 
    };
  }

  async wait_for_updates(req: WaitForUpdatesRequest): Promise<WaitForUpdatesResponse> {
    const since = req.sinceSeq ?? 0;
    const limit = Math.max(1, Math.min(1000, req.limit ?? 200));
    const timeoutMs = Math.min(120000, Math.max(0, req.timeoutMs ?? 0));

    const compute = () => {
      const snap = this.orch.getConversationSnapshot(req.conversationId);
      const msgs = snap.events
        .filter((e) => e.seq > since && e.type === 'message')
        .slice(0, limit)
        .map(this.toPublicMessage);

      const latestSeq = snap.events.length ? snap.events[snap.events.length - 1]!.seq : since;
      const guidance = computeGuidance(snap.events, snap.status);

      const result: Omit<WaitForUpdatesResponse, 'timedOut'> = {
        conversationId: req.conversationId,
        latestSeq,
        status: snap.status,
        messages: msgs,
        guidance: guidance.kind,
      };
      if (guidance.note !== undefined) result.note = guidance.note;
      return result;
    };

    const immediate = compute();
    
    // Return immediately if no wait requested or if we can already speak
    if (timeoutMs === 0 || immediate.guidance === 'you_may_speak' || immediate.status === 'completed') {
      return { ...immediate, timedOut: false };
    }

    // Long-poll implementation
    return await new Promise<WaitForUpdatesResponse>((resolve) => {
      let cleanup: () => void;
      
      const subId = this.orch.subscribe(req.conversationId, (_e: UnifiedEvent) => {
        const state = compute();
        if (
          state.guidance === 'you_may_speak' ||
          state.status === 'completed' ||
          state.latestSeq > immediate.latestSeq
        ) {
          cleanup();
          resolve({ ...state, timedOut: false });
        }
      });

      const timeoutId = setTimeout(() => {
        cleanup();
        const state = compute();
        resolve({ ...state, timedOut: true });
      }, timeoutMs);

      cleanup = () => {
        clearTimeout(timeoutId);
        this.orch.unsubscribe(subId);
      };
    });
  }

  private toPublicMessage = (e: UnifiedEvent): PublicMessage => {
    const p = e.payload as MessagePayload;
    const result: PublicMessage = {
      conversationId: e.conversation,
      turn: e.turn,
      event: e.event,
      seq: e.seq,
      ts: e.ts,
      agentId: e.agentId,
      text: p.text ?? '',
      finality: e.finality,
    };
    
    // Convert attachments format (id is required in PublicMessage)
    if (p.attachments) {
      result.attachments = p.attachments
        .filter(a => a.id !== undefined)
        .map(a => {
          const attachment: NonNullable<PublicMessage['attachments']>[number] = {
            id: a.id!,
            name: a.name,
            contentType: a.contentType,
          };
          if (a.summary !== undefined) attachment.summary = a.summary;
          if (a.docId !== undefined) attachment.docId = a.docId;
          return attachment;
        });
    }
    
    if (p.outcome !== undefined) result.outcome = p.outcome;
    
    return result;
  };
}

// Guidance that hides internal details and uses only public message events
function computeGuidance(
  events: UnifiedEvent[],
  status: 'active' | 'completed'
): { kind: 'you_may_speak' | 'wait' | 'closed' | 'unknown'; note?: string } {
  if (status === 'completed') return { kind: 'closed' };
  if (!events.length) return { kind: 'you_may_speak' };

  const lastMsg = [...events].reverse().find((e) => e.type === 'message');
  if (!lastMsg) return { kind: 'unknown' };

  if (lastMsg.finality === 'turn') {
    return { kind: 'you_may_speak' };
  }
  if (lastMsg.finality === 'none') {
    return { kind: 'wait', note: `${lastMsg.agentId} is still working` };
  }
  if (lastMsg.finality === 'conversation') {
    return { kind: 'closed' };
  }
  return { kind: 'unknown' };
}