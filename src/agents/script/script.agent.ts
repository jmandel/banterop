import { BaseAgent, type TurnContext, type TurnRecoveryMode } from '$src/agents/runtime/base-agent';
import type { IAgentTransport } from '$src/agents/runtime/runtime.interfaces';
import type { AgentScript, TurnBasedScript, ScriptAction } from './script.types';
import type { TracePayload } from '$src/types/event.types';
import { logLine } from '$src/lib/utils/logger';

export class ScriptAgent extends BaseAgent {
  private turnCount = 0;
  private script: AgentScript | TurnBasedScript;
  
  constructor(
    transport: IAgentTransport,
    script: AgentScript | TurnBasedScript,
    options?: { turnRecoveryMode?: TurnRecoveryMode }
  ) {
    super(transport, options);
    this.script = script;
  }

  protected async takeTurn(ctx: TurnContext): Promise<void> {
    this.turnCount++;
    
    // Check if this is a turn-based script
    if ('turns' in this.script) {
      await this.executeTurnBasedScript(ctx, this.script);
    } else {
      await this.executeSimpleScript(ctx, this.script);
    }
  }
  
  private async executeTurnBasedScript(ctx: TurnContext, script: TurnBasedScript): Promise<void> {
    const { agentId } = ctx;
    
    // Add default delay if configured
    if (script.defaultDelay) {
      await sleep(script.defaultDelay);
    }
    
    // Check if we've exceeded max turns
    const maxTurns = script.maxTurns ?? script.turns.length;
    if (this.turnCount > maxTurns) {
      logLine(agentId, 'info', `Turn ${this.turnCount} exceeds max ${maxTurns}, ending conversation`);
      await ctx.transport.postMessage({
        conversationId: ctx.conversationId,
        agentId,
        text: 'Thank you for the conversation.',
        finality: 'conversation'
      });
      return;
    }
    
    // Get the steps for this turn (cycle if we run out)
    const turnIndex = (this.turnCount - 1) % script.turns.length;
    const turnSteps = script.turns[turnIndex];
    
    if (!turnSteps || turnSteps.length === 0) {
      logLine(agentId, 'warn', `No steps defined for turn ${this.turnCount}`);
      return;
    }
    
    logLine(agentId, 'info', `Executing turn ${this.turnCount} (script index ${turnIndex})`);
    
    // Execute the steps for this turn
    for (const step of turnSteps) {
      await this.executeStep(ctx, step);
    }
    
    // If this is the last planned turn, end the conversation
    if (this.turnCount === maxTurns && turnSteps.length > 0) {
      const lastStep = turnSteps[turnSteps.length - 1];
      if (lastStep && lastStep.kind === 'post' && lastStep.finality !== 'conversation') {
        // Override finality to end conversation
        await ctx.transport.postMessage({
          conversationId: ctx.conversationId,
          agentId,
          text: 'Thank you for the discussion.',
          finality: 'conversation'
        });
      }
    }
  }
  
  private async executeSimpleScript(ctx: TurnContext, script: AgentScript): Promise<void> {
    for (const step of script.steps) {
      await this.executeStep(ctx, step);
    }
  }
  
  private async executeStep(ctx: TurnContext, step: ScriptAction): Promise<void> {
    switch (step.kind) {
      case 'sleep':
        await sleep(step.ms);
        break;
      case 'trace':
        if (step.delayMs) await sleep(step.delayMs);
        await ctx.transport.postTrace({
          conversationId: ctx.conversationId,
          agentId: ctx.agentId,
          payload: step.payload as TracePayload,
        });
        break;
      case 'post':
        if (step.delayMs) await sleep(step.delayMs);
        await ctx.transport.postMessage({
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

async function assertPredicate(ctx: TurnContext, step: Extract<ScriptAction, {kind:'assert'}>) {
  const snap = ctx.snapshot;
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