import type { AgentContext } from './agent.types';
import type { TracePayload } from '$src/types/event.types';

export async function post(
  ctx: AgentContext,
  text: string,
  finality: 'none' | 'turn' | 'conversation' = 'turn',
  attachments?: Array<{
    id?: string;
    docId?: string;
    name: string;
    contentType: string;
    content?: string;
    summary?: string;
  }>,
  clientRequestId?: string,
  turn?: number // unified
) {
  const params: Parameters<typeof ctx.client.postMessage>[0] = {
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    text,
    finality,
  };
  if (attachments !== undefined) params.attachments = attachments;
  if (clientRequestId !== undefined) params.clientRequestId = clientRequestId;
  if (turn !== undefined) params.turn = turn;
  return ctx.client.postMessage(params);
}

export async function postTrace(
  ctx: AgentContext,
  trace: TracePayload,
  turn?: number,
  clientRequestId?: string
) {
  const params: Parameters<typeof ctx.client.postTrace>[0] = {
    conversationId: ctx.conversationId,
    agentId: ctx.agentId,
    payload: trace,
  };
  if (turn !== undefined) params.turn = turn;
  if (clientRequestId !== undefined) params.clientRequestId = clientRequestId;
  return ctx.client.postTrace(params);
}
