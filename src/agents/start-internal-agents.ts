import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import type { Logger } from '$src/agents/agent.types';
import { TurnLoopExecutorInternal } from '$src/agents/executors/turn-loop-executor.internal';
import { buildAgent, type BuildAgentContext } from '$src/agents/factories/agent-builder';
import { logLine, colors } from '$src/lib/utils/logger';

export interface StartInternalAgentsOptions {
  orchestrator: OrchestratorService;
  conversationId: number;
  buildContext: BuildAgentContext;
  logger?: Logger;
}

/**
 * Start internal agent loops for a conversation
 * This function creates a TurnLoopExecutorInternal for each internal agent
 * in the conversation metadata. Agents are instantiated per-turn using buildAgent.
 */
export async function startInternalAgents({
  orchestrator,
  conversationId,
  buildContext,
  logger,
}: StartInternalAgentsOptions) {
  const snapshot = await orchestrator.getConversationSnapshot(conversationId);
  const loops: TurnLoopExecutorInternal[] = [];
  
  const defaultLogger: Logger = {
    debug: (msg: string) => logLine('startInternalAgents', 'debug', msg),
    info: (msg: string) => logLine('startInternalAgents', 'info', msg),
    warn: (msg: string) => logLine('startInternalAgents', colors.yellow('warn'), msg),
    error: (msg: string) => logLine('startInternalAgents', colors.red('error'), msg),
  };
  
  const log = logger ?? defaultLogger;
  
  log.info(`Starting internal agents for conversation ${conversationId}`);
  
  for (const meta of snapshot.metadata.agents) {
    if (meta.kind !== 'internal') continue;
    
    log.info(`Creating loop for internal agent: ${meta.id}`);
    
    const loop = new TurnLoopExecutorInternal(orchestrator, {
      conversationId,
      agentId: meta.id,
      meta,
      buildAgent: (agentMeta) => buildAgent(agentMeta, buildContext),
      logger: {
        debug: (msg: string) => log.debug(`[${meta.id}] ${msg}`),
        info: (msg: string) => log.info(`[${meta.id}] ${msg}`),
        warn: (msg: string) => log.warn(`[${meta.id}] ${msg}`),
        error: (msg: string) => log.error(`[${meta.id}] ${msg}`),
      },
    });
    
    // Start the loop asynchronously
    void loop.start();
    loops.push(loop);
  }
  
  log.info(`Started ${loops.length} internal agent loops`);
  
  return {
    loops,
    stop: async () => {
      log.info('Stopping all internal agent loops');
      for (const loop of loops) {
        loop.stop();
      }
    },
  };
}