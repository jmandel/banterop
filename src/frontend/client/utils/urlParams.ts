export type LaunchParams = {
  // Connection
  endpoint?: string;
  protocol?: 'a2a' | 'mcp' | 'auto';

  // Scenario
  scenarioUrl?: string;
  plannerAgentId?: string;
  counterpartAgentId?: string;

  // Configuration
  defaultModel?: string;
  instructions?: string;

  // Task
  resumeTaskId?: string;
};

// Support both /#/?param and /#/route?param patterns
export function extractLaunchParams(): LaunchParams {
  try {
    const hash = (typeof window !== 'undefined' ? window.location.hash : '') || '';
    const queryStart = hash.indexOf('?');
    if (queryStart === -1) return {};
    const queryString = hash.slice(queryStart + 1);
    const params = new URLSearchParams(queryString);
    const proto = params.get('protocol');
    const protocol = proto === 'a2a' || proto === 'mcp' || proto === 'auto' ? proto : undefined;
    return {
      endpoint: params.get('endpoint') || undefined,
      protocol,
      scenarioUrl: params.get('scenarioUrl') || undefined,
      plannerAgentId: params.get('plannerAgentId') || undefined,
      counterpartAgentId: params.get('counterpartAgentId') || undefined,
      defaultModel: params.get('defaultModel') || undefined,
      instructions: params.get('instructions') || undefined,
      resumeTaskId: params.get('resumeTaskId') || undefined,
    };
  } catch {
    return {};
  }
}

export function clearUrlParams(): void {
  try {
    const hash = (typeof window !== 'undefined' ? window.location.hash : '') || '';
    const queryStart = hash.indexOf('?');
    if (queryStart === -1) return;
    const basePath = hash.slice(0, queryStart);
    const next = basePath || '#/';
    window.history.replaceState(null, '', next);
  } catch {
    // ignore
  }
}

