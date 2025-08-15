// src/server/bridge/a2a-wellknown.ts
import type { OrchestratorService } from '$src/server/orchestrator/orchestrator';
import { parseConversationMetaFromConfig64 } from '$src/server/bridge/conv-config.types';

export function buildScenarioAgentCard(baseUrlToA2A: URL, config64: string, orchestrator: OrchestratorService) {
  // baseUrlToA2A points to ".../:config64/a2a"
  // Parse scenario meta to enrich the card (title/agents/examples).
  const meta = parseConversationMetaFromConfig64(config64);

  // Try to derive some friendly info
  let title = meta.title || meta.scenarioId || 'A2A Scenario';
  let agentSummaries: string[] = [];
  let scenarioDescription: string | undefined;
  const externalId = (meta as any).startingAgentId || (meta.agents?.[0]?.id ?? 'external');
  let externalPrincipal: { name?: string; description?: string } | undefined;
  let internalId: string | undefined;
  let internalPrincipal: { name?: string; description?: string } | undefined;
  try {
    if (meta.scenarioId) {
      const sc = orchestrator.storage?.scenarios?.findScenarioById(meta.scenarioId);
      if (sc) {
        title = (sc as any).config?.metadata?.title || (sc as any).name || title;
        scenarioDescription = (sc as any).config?.metadata?.description || (sc as any).config?.scenario?.background;
        const scAgents = ((sc as any).config?.agents || []);
        agentSummaries = scAgents.map((a: any) => {
          const n = a?.principal?.name || a?.agentId || '';
          return `${a.agentId}${n && n !== a.agentId ? ` (${n})` : ''}`;
        });
        // find principal for the external agent id when possible
        const match = scAgents.find((a: any) => a?.agentId === externalId);
        if (match?.principal) {
          externalPrincipal = { name: match.principal.name, description: match.principal.description };
        }
        // choose a primary server-side counterpart (first non-external agent)
        const server = scAgents.find((a: any) => a?.agentId && a.agentId !== externalId);
        if (server) {
          internalId = server.agentId;
          if (server.principal) internalPrincipal = { name: server.principal.name, description: server.principal.description };
        }
      }
    }
  } catch {
    /* ignore */
  }

  if (agentSummaries.length === 0) {
    agentSummaries = (meta.agents || []).map(
      (a) => `${a.id}`
    );
  }

  const principalBlurb = externalPrincipal?.name
    ? `representing principal "${externalPrincipal.name}"${externalPrincipal.description ? ` — ${externalPrincipal.description}` : ''}`
    : 'representing the configured external participant';
  const scenarioBlurb = scenarioDescription ? ` ${scenarioDescription}` : '';
  const remoteDesc = externalPrincipal?.name
    ? `you, as client representing "${externalPrincipal.name}"${externalPrincipal.description ? ` — ${externalPrincipal.description}` : ''}`
    : 'you, as client';
  const serverDesc = internalId
    ? internalPrincipal?.name
      ? `us, representing "${internalPrincipal.name}"${internalPrincipal.description ? ` — ${internalPrincipal.description}` : ''}`
      : 'us, server-side agent'
    : undefined;

  // Concise description for the skill: focus on the counterpart role/principal
  const skillDescription = (() => {
    if (internalId) {
      if (internalPrincipal?.name) {
        const blurb = internalPrincipal.description ? ` — ${internalPrincipal.description}` : '';
        return `Open a conversation with ${internalId} acting for "${internalPrincipal.name}"${blurb}.`;
      }
      return `Open a conversation with ${internalId}.`;
    }
    // Fallback to external role if no internal counterpart detected
    if (externalPrincipal?.name) {
      const blurb = externalPrincipal.description ? ` — ${externalPrincipal.description}` : '';
      return `Open a conversation with ${externalId} acting for "${externalPrincipal.name}"${blurb}.`;
    }
    return `Open a conversation with ${externalId}.`;
  })();

  const skillName = `Connect with ${internalId || externalId}`;

  // Minimal, scenario-specific card
  return {
    protocolVersion: '0.2.9',
    name: `A2A Scenario Tester: ${title}`,
    description: 'Open conversation for connectathon testing.',
    url: baseUrlToA2A.toString(),
    preferredTransport: 'JSONRPC',
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    defaultInputModes: ['application/json', 'text/plain'],
    defaultOutputModes: ['application/json', 'text/plain'],
    // A simple, scenario-tied "skill" (optional but helps discovery UIs)
    skills: [
      {
        id: 'conversation-facade',
        name: skillName,
        description: skillDescription,
        tags: ['conversation', 'scenario', 'interop'],
        examples: [
          'Start a new task and send: "Hello, please begin."',
          'Attach a PDF and ask the counterpart to review.',
        ],
        inputModes: ['application/json', 'text/plain'],
        outputModes: ['application/json', 'text/plain'],
      },
    ],
    // Non-normative hint to explain the config64 nature of this card
    extensions: [
      {
        id: 'a2a.config64',
        name: 'Config64 Binding',
        description:
          'This Agent Card is scoped to the ConversationMeta encoded in the URL path.',
        config64,
      },
    ],
  };
}
