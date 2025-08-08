import type { Agent, AgentContext } from '$src/agents/agent.types';
import type { AgentScript, ScriptAction } from './script.types';
import type { TracePayload } from '$src/types/event.types';

export class ScriptAgent implements Agent {
  constructor(private script: AgentScript) {}

  async handleTurn(ctx: AgentContext): Promise<void> {
    for (const step of this.script.steps) {
      switch (step.kind) {
        case 'sleep':
          await sleep(step.ms);
          break;
        case 'trace':
          if (step.delayMs) await sleep(step.delayMs);
          await ctx.client.postTrace({
            conversationId: ctx.conversationId,
            agentId: ctx.agentId,
            payload: step.payload as TracePayload,
          });
          break;
        case 'post':
          if (step.delayMs) await sleep(step.delayMs);
          await ctx.client.postMessage({
            conversationId: ctx.conversationId,
            agentId: ctx.agentId,
            text: step.text,
            finality: step.finality ?? 'turn',
          });
          break;
        case 'assert':
          await assertPredicate(ctx, step);
          break;
      }
    }
  }
}

async function assertPredicate(ctx: AgentContext, step: Extract<ScriptAction, {kind:'assert'}>) {
  const snap = await ctx.client.getSnapshot(ctx.conversationId);
  const lastMsg = [...snap.events].reverse().find((e: unknown) => {
    const typed = e as { type: string };
    return typed.type === 'message';
  });
  
  if (!lastMsg) throw new Error('assert failed: no last message');
  
  if (step.predicate === 'lastMessageContains') {
    const payload = (lastMsg as { payload?: { text?: string } }).payload;
    const text = payload?.text ?? '';
    if (!text.includes(step.text)) {
      throw new Error(`assert failed: last message does not contain "${step.text}"`);
    }
  } else {
    throw new Error(`unknown predicate: ${step.predicate}`);
  }
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}