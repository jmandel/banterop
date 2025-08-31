export function deriveChatLabels(plannerId: string, plannerConfig: any): { usLabel: string; otherLabel: string } {
  const defaults = { usLabel: 'Us', otherLabel: 'Other Side' };
  try {
    if (plannerId !== 'scenario-v0.3' || !plannerConfig) return defaults;
    const scen = (plannerConfig && typeof plannerConfig === 'object') ? (plannerConfig as any).scenario : undefined;
    const agents = Array.isArray((scen as any)?.agents) ? (scen as any).agents : [];
    if (!agents.length) return defaults;
    const myId = String((plannerConfig as any).myAgentId || (agents[0]?.agentId || ''));
    const me = agents.find((a:any) => String(a?.agentId || '') === myId) || agents[0];
    const other = agents.find((a:any) => String(a?.agentId || '') !== String(me?.agentId || '')) || agents[1] || agents[0];
    const nameOf = (a:any) => {
      const nm = (a && a.principal && typeof a.principal.name === 'string') ? a.principal.name.trim() : '';
      return nm || (typeof a?.agentId === 'string' ? a.agentId : '');
    };
    const uBase = nameOf(me);
    const oBase = nameOf(other);
    return {
      usLabel: (uBase ? uBase : defaults.usLabel) + ' (Us)',
      otherLabel: (oBase ? oBase : defaults.otherLabel) + ' (Remote Agent)',
    };
  } catch {
    return defaults;
  }
}

