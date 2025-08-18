import React, { useState, useEffect } from 'react';
import { Button } from '../../../ui';

interface ScenarioDetectorProps {
  endpoint: string;
  goals: string;
  instructions: string;
  onLoadScenario: (goals: string, instructions: string) => void;
}

function parseConversationMetaFromConfig64(config64: string) {
  try {
    const json = atob(config64.replace(/-/g, '+').replace(/_/g, '/'));
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function isOurBridgeEndpoint(url: string): { isOurs: boolean; config64?: string; apiBase?: string } {
  const match = url.match(/^(https?:\/\/[^\/]+)(\/api)?\/bridge\/([^\/]+)\/a2a/);
  if (!match || !match[3]) {
    return { isOurs: false };
  }
  
  const apiBase = match[2] ? match[1] + match[2] : match[1] + '/api';
  return { 
    isOurs: true, 
    config64: match[3],
    apiBase 
  };
}

export const ScenarioDetector: React.FC<ScenarioDetectorProps> = ({ endpoint, goals, instructions, onLoadScenario }) => {
  const [canLoad, setCanLoad] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [scenarioData, setScenarioData] = useState<{ config64: string; apiBase: string } | null>(null);
  const [preview, setPreview] = useState<{ goals: string; instructions: string } | null>(null);
  const [willChange, setWillChange] = useState<boolean>(false);

  useEffect(() => {
    setDismissed(false);
    setError(null);
    const { isOurs, config64, apiBase } = isOurBridgeEndpoint(endpoint);
    
    if (isOurs && config64 && apiBase) {
      setCanLoad(true);
      setScenarioData({ config64, apiBase });
    } else {
      setCanLoad(false);
      setScenarioData(null);
    }
  }, [endpoint]);

  // Prefetch and compute whether applying would change current fields
  useEffect(() => {
    (async () => {
      setPreview(null);
      setWillChange(false);
      setError(null);
      if (!scenarioData) return;
      try {
        const meta = parseConversationMetaFromConfig64(scenarioData.config64);
        if (!meta?.scenarioId || !meta?.startingAgentId) return;
        const response = await fetch(`${scenarioData.apiBase}/scenarios/${meta.scenarioId}`);
        if (!response.ok) return;
        const scenario = await response.json();
        const externalAgent = scenario?.config?.agents?.find((a: any) => a.agentId === meta.startingAgentId);
        const internalAgents = scenario?.config?.agents?.filter((a: any) => a.agentId !== meta.startingAgentId) || [];
        if (!externalAgent) return;

        const proposedGoals = [
          `# Scenario: ${scenario.config.metadata.title}`,
          '',
          '## Your Identity',
          `You are agent "${meta.startingAgentId}" acting on behalf of:`,
          `Principal: ${externalAgent.principal?.name || 'Unknown'}`,
          `Principal Type: ${externalAgent.principal?.type || 'Unknown'}`,
          `Principal Description: ${externalAgent.principal?.description || 'Not specified'}`,
          '',
          'As this agent, you:',
          '- Have access to your knowledge base and can reference it when making decisions',
          '- Can act autonomously within your defined capabilities',
          '- May consult with your principal when decisions exceed your authority',
          '- Should maintain consistency with your principal\'s interests and goals',
          '',
          '## Your Situation',
          externalAgent.situation || 'No specific situation provided',
          '',
          '## Your Goals',
          ...(externalAgent.goals || []).map((g: string, i: number) => `${i + 1}. ${g}`),
          '',
          '## Your Counterpart(s)',
          ...internalAgents.map((agent: any) => [
            `Agent: "${agent.agentId}"`,
            `Acting for: ${agent.principal?.name || 'Unknown'} (${agent.principal?.type || 'Unknown type'})`,
            `Description: ${agent.principal?.description || 'Not specified'}`,
            ''
          ].join('\n')),
          '',
          '## Scenario Background',
          scenario.config.metadata.background || 'No background provided',
        ].join('\n');

        const proposedInstructions = [
          `You are agent "${meta.startingAgentId}" acting on behalf of "${externalAgent.principal?.name}".`,
          '',
          'Your available tools and capabilities:',
          ...(externalAgent.tools?.length > 0 
            ? externalAgent.tools.map((t: any) => `- ${t.name}: ${t.description}`)
            : ['- No specific tools configured']),
          '',
          'Key points from your knowledge base:',
          ...(externalAgent.knowledgeBase && Object.keys(externalAgent.knowledgeBase).length > 0
            ? Object.entries(externalAgent.knowledgeBase).slice(0, 5).map(([key, value]) => 
                `- ${key}: ${JSON.stringify(value).substring(0, 100)}...`)
            : ['- No knowledge base entries']),
          '',
          'Scenario challenges to address:',
          ...(scenario.config.metadata.challenges?.length > 0
            ? scenario.config.metadata.challenges.map((c: string) => `- ${c}`)
            : ['- No specific challenges identified']),
          '',
          'Remember: You have autonomous decision-making capability within these parameters,',
          'but should consult your principal for decisions outside your defined scope.'
        ].join('\n');

        setPreview({ goals: proposedGoals, instructions: proposedInstructions });
        setWillChange((proposedGoals !== goals) || (proposedInstructions !== instructions));
      } catch {
        // ignore; best-effort only
      }
    })();
  }, [scenarioData, goals, instructions]);

  const loadScenario = async () => {
    if (!scenarioData) return;
    
    setLoading(true);
    setError(null);
    
    try {
      // Decode config64
      const meta = parseConversationMetaFromConfig64(scenarioData.config64);
      if (!meta) {
        throw new Error('Invalid configuration encoding');
      }
      
      if (!meta.scenarioId) {
        throw new Error('No scenario ID found in configuration');
      }
      
      if (!meta.startingAgentId) {
        throw new Error('No starting agent specified');
      }
      
      // Fetch scenario only if not prefetched
      let fetchedScenario: any = null;
      if (!preview) {
        const response = await fetch(`${scenarioData.apiBase}/scenarios/${meta.scenarioId}`);
        if (!response.ok) {
          throw new Error(`Cannot fetch scenario: ${response.statusText}`);
        }
        fetchedScenario = await response.json();
      }
      
      // Find agents
      const scenarioObj = fetchedScenario || null;
      const externalAgent = preview ? true : scenarioObj?.config?.agents?.find((a: any) => a.agentId === meta.startingAgentId);
      if (!externalAgent) {
        throw new Error(`Cannot find agent "${meta.startingAgentId}" in scenario`);
      }
      
      const internalAgents = scenarioObj?.config?.agents?.filter((a: any) => a.agentId !== meta.startingAgentId);
      
      // Build goals and instructions
      const goals = preview?.goals ?? [
        `# Scenario: ${scenarioObj?.config?.metadata?.title}`,
        '',
        '## Your Identity',
        `You are agent "${meta.startingAgentId}" acting on behalf of:`,
        `Principal: ${externalAgent.principal?.name || 'Unknown'}`,
        `Principal Type: ${externalAgent.principal?.type || 'Unknown'}`,
        `Principal Description: ${externalAgent.principal?.description || 'Not specified'}`,
        '',
        'As this agent, you:',
        '- Have access to your knowledge base and can reference it when making decisions',
        '- Can act autonomously within your defined capabilities',
        '- May consult with your principal when decisions exceed your authority',
        '- Should maintain consistency with your principal\'s interests and goals',
        '',
        '## Your Situation',
        externalAgent.situation || 'No specific situation provided',
        '',
        '## Your Goals',
        ...(externalAgent.goals || []).map((g: string, i: number) => `${i + 1}. ${g}`),
        '',
        '## Your Counterpart(s)',
        ...internalAgents.map((agent: any) => [
          `Agent: "${agent.agentId}"`,
          `Acting for: ${agent.principal?.name || 'Unknown'} (${agent.principal?.type || 'Unknown type'})`,
          `Description: ${agent.principal?.description || 'Not specified'}`,
          ''
        ].join('\n')),
        '',
        '## Scenario Background',
        scenarioObj?.config?.metadata?.background || 'No background provided',
      ].join('\n');
      
      const instructions = preview?.instructions ?? [
        `You are agent "${meta.startingAgentId}" acting on behalf of "${externalAgent.principal?.name}".`,
        '',
        'Your available tools and capabilities:',
        ...(externalAgent.tools?.length > 0 
          ? externalAgent.tools.map((t: any) => `- ${t.name}: ${t.description}`)
          : ['- No specific tools configured']),
        '',
        'Key points from your knowledge base:',
        ...(externalAgent.knowledgeBase && Object.keys(externalAgent.knowledgeBase).length > 0
          ? Object.entries(externalAgent.knowledgeBase).slice(0, 5).map(([key, value]) => 
              `- ${key}: ${JSON.stringify(value).substring(0, 100)}...`)
          : ['- No knowledge base entries']),
        '',
        'Scenario challenges to address:',
        ...(scenarioObj?.config?.metadata?.challenges?.length > 0
          ? scenarioObj.config.metadata.challenges.map((c: string) => `- ${c}`)
          : ['- No specific challenges identified']),
        '',
        'Remember: You have autonomous decision-making capability within these parameters,',
        'but should consult your principal for decisions outside your defined scope.'
      ].join('\n');
      
      onLoadScenario(goals, instructions);
      setDismissed(true);
      
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!canLoad || dismissed || !willChange) return null;

  return (
    <div className="mt-4 p-4 bg-blue-50 rounded-lg border border-blue-200">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h4 className="text-sm font-semibold text-blue-900">
            Scenario Configuration Detected
          </h4>
          <p className="text-xs text-blue-700 mt-1">
            This endpoint has a pre-configured scenario. Load it to replace your current goals and instructions.
          </p>
          {error && (
            <p className="text-xs text-red-600 mt-2">
              Error: {error}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setDismissed(true)}
            disabled={loading}
          >
            No Thanks
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={loadScenario}
            disabled={loading}
          >
            {loading ? 'Loading...' : 'Load Scenario'}
          </Button>
        </div>
      </div>
    </div>
  );
};
