import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardHeader, Button, ModelSelect } from '../../ui';
import { api } from '../utils/api';

type Protocol = 'a2a' | 'mcp';

// Local stub for a previously imported helper used only in dead code below
function buildBridgeEndpoint(_apiBase: string, protocol: Protocol, _config64: string): { label: string; url: string } {
  return { label: protocol.toUpperCase(), url: '' };
}

// Encode object to base64url (safe no-op fallback)
function encodeBase64Url(obj: unknown): string {
  try {
    const json = JSON.stringify(obj);
    const base64 = btoa(json).replace(/=+$/, '');
    return base64.replace(/\+/g, '-').replace(/\//g, '_');
  } catch {
    return '';
  }
}

export function RunWizardPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<any | null>(null);

  // Step 1: Choose your role
  const [role, setRole] = useState<string>('');
  // Step 2: Choose connection pattern
  const [hasClient, setHasClient] = useState<boolean>(true);
  const [protocol, setProtocol] = useState<Protocol>('a2a');
  const [serverUrl, setServerUrl] = useState<string>('');

  // Step 3/4: Configure simulated agent(s)
  const [providers, setProviders] = useState<Array<{ name: string; models: string[] }>>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [instructions, setInstructions] = useState<string>('');
  const [agentInstructions, setAgentInstructions] = useState<Record<string, string>>({});
  // Used by hidden UI and dead code paths; keep to satisfy JSX references
  const [startFirst, setStartFirst] = useState<string>('');
  

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        const res = await api.getScenario(scenarioId!);
        if (!res.success) throw new Error('Failed to load scenario');
        const s = res.data;
        setScenario(s);
        const cfg = s.config || s;
        const firstId = (cfg?.agents?.[0]?.agentId) || '';
        setRole(firstId);
        try {
          const initInstr: Record<string, string> = {};
          for (const a of (cfg?.agents || [])) initInstr[a.agentId] = '';
          setAgentInstructions(initInstr);
        } catch {}
        try {
          const p = await api.getLLMConfig();
          if (p.success) {
            const filtered = (p.data.providers || []).filter((x: any) =>
              x.name !== 'browserside' && x.name !== 'mock' && x.available !== false
            );
            // Prefer OpenRouter provider, if present
            const openrouter = filtered.find((x: any) => x.name === 'openrouter');
            const others = filtered.filter((x: any) => x.name !== 'openrouter');
            const ordered = openrouter ? [openrouter, ...others] : filtered;
            setProviders(ordered);
            const flat = ordered.flatMap((x: any) => x.models || []);
            const defaultModel = flat.includes('@preset/chitchat') ? '@preset/chitchat' : (flat[0] || '');
            if (defaultModel) setSelectedModel(defaultModel);
          }
        } catch {}
      } catch (e: any) {
        setError(e?.message || 'Failed to load scenario');
      } finally {
        setLoading(false);
      }
    })();
  }, [scenarioId]);

  // Persist selected model globally so it defaults across scenarios
  useEffect(() => {
    const key = `scenario.run.model.default`;
    try {
      // Load saved model once providers are available
      if (!providers.length) return;
      const saved = localStorage.getItem(key) || '';
      if (saved) {
        const available = providers.flatMap(p => p.models || []);
        if (available.includes(saved)) {
          setSelectedModel(saved);
        }
      }
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providers.length, scenarioId]);

  useEffect(() => {
    const key = `scenario.run.model.default`;
    try {
      if (selectedModel) localStorage.setItem(key, selectedModel);
    } catch {}
  }, [selectedModel]);

  const agentIds: string[] = useMemo(
    () => (scenario?.config?.agents || []).map((a: any) => a.agentId),
    [scenario]
  );

  const simulatedAgentId = useMemo(() => {
    if (!role) return '';
    if (agentIds.length === 2) return agentIds.find((a) => a !== role) || '';
    // Fallback: first different or same
    return agentIds.find((a) => a !== role) || agentIds[0] || '';
  }, [agentIds, role]);

  // Helper function to build metadata for simulation (used only in disabled code path)
  const buildMeta = () => {
    const cfg = scenario?.config || scenario;
    const sid = cfg?.metadata?.id || scenarioId;
    const agents = (cfg?.agents || []).map((a: any) => {
      const conf: Record<string, unknown> = {};
      if (selectedModel) conf.model = selectedModel;
      const extra = (agentInstructions[a.agentId] || '').trim();
      if (extra) conf.systemPromptExtra = extra;
      return Object.keys(conf).length ? { id: a.agentId, config: conf } : { id: a.agentId };
    });
    return {
      title: `Run: ${cfg?.metadata?.title || scenario?.name || ''}`,
      scenarioId: sid,
      agents,
      startingAgentId: startFirst || (agents[0] as any)?.id || '',
    } as any;
  };

  const onLaunch = () => {
    const cfg = scenario?.config || scenario;
    const sid = cfg?.metadata?.id || scenarioId || '';
    const base = api.getBaseUrl();
    const scenarioUrl = `${base}/api/scenarios/${encodeURIComponent(String(sid))}`;
    const defaultSteps = 20;
    const scenarioTitle = cfg?.metadata?.title || scenario?.name || String(sid);

    // Choose who the platform will control vs. who the participant provides
    const myAgentForServer = simulatedAgentId || '';
    const myAgentForClient = role || '';

    if (hasClient) {
      // Participant has a CLIENT → open /rooms/:roomId with scenario planner in auto mode
      const seed = {
        v: 2,
        scenarioUrl,
        model: selectedModel || '',
        myAgentId: myAgentForServer,
        maxInlineSteps: defaultSteps,
        ...(instructions && instructions.trim() ? { instructions: instructions.trim() } : {}),
      };
      const roomId = String(sid || 'room');
      const readable = {
        planner: { id: 'scenario-v0.3', mode: 'approve' as const },
        planners: { ['scenario-v0.3']: { seed } },
        llm: { provider: 'server', model: selectedModel || '' },
        roomTitle: scenarioTitle,
      };
      const href = `/rooms/${encodeURIComponent(roomId)}#${JSON.stringify(readable)}`;
      try { window.open(href, '_blank'); } catch { navigate(href); }
    } else {
      // Participant has a SERVER → open /client prefilled with server URL (MCP or Agent Card) + scenario planner in approve mode
      const seed = {
        v: 2,
        scenarioUrl,
        model: selectedModel || '',
        myAgentId: myAgentForClient,
        maxInlineSteps: defaultSteps,
        ...(instructions && instructions.trim() ? { instructions: instructions.trim() } : {}),
      };
      const trimmed = serverUrl.trim();
      const readable = {
        ...(protocol === 'mcp' ? { mcpUrl: trimmed } : { agentCardUrl: trimmed }),
        planner: { id: 'scenario-v0.3', mode: 'approve' as const },
        planners: { ['scenario-v0.3']: { seed } },
        llm: { provider: 'server', model: selectedModel || '' },
      };
      const href = `/client/#${JSON.stringify(readable)}`;
      try { window.open(href, '_blank'); } catch { navigate(href); }
    }
  };

  // Precompute share links so users can right‑click or copy
  const computedRoomHref = React.useMemo(() => {
    try {
      if (!scenario) return '';
      const cfg = scenario?.config || scenario;
      const sid = cfg?.metadata?.id || scenarioId || '';
      const base = api.getBaseUrl();
      const scenarioUrl = `${base}/api/scenarios/${encodeURIComponent(String(sid))}`;
      const defaultSteps = 20;
      const myAgentForServer = simulatedAgentId || '';
      const seed: any = {
        v: 2,
        scenarioUrl,
        model: selectedModel || '',
        myAgentId: myAgentForServer,
        maxInlineSteps: defaultSteps,
        ...(instructions && instructions.trim() ? { instructions: instructions.trim() } : {}),
      };
      const roomId = String(sid || 'room');
      const scenarioTitle = cfg?.metadata?.title || scenario?.name || String(sid);
      const readable: any = {
        planner: { id: 'scenario-v0.3', mode: 'approve' as const },
        planners: { ['scenario-v0.3']: { seed } },
        llm: { provider: 'server', model: selectedModel || '' },
        roomTitle: scenarioTitle,
      };
      return `/rooms/${encodeURIComponent(roomId)}#${JSON.stringify(readable)}`;
    } catch { return ''; }
  }, [scenario, scenarioId, simulatedAgentId, selectedModel, instructions]);

  // Precompute client link for "server mode" so users can right‑click/copy
  const computedClientHref = React.useMemo(() => {
    try {
      const trimmed = serverUrl.trim();
      if (!trimmed) return '';
      const cfg = scenario?.config || scenario;
      const sid = cfg?.metadata?.id || scenarioId || '';
      const base = api.getBaseUrl();
      const scenarioUrl = `${base}/api/scenarios/${encodeURIComponent(String(sid))}`;
      const defaultSteps = 20;
      const myAgentForClient = role || '';
      const seed = {
        v: 2,
        scenarioUrl,
        model: selectedModel || '',
        myAgentId: myAgentForClient,
        maxInlineSteps: defaultSteps,
        ...(instructions && instructions.trim() ? { instructions: instructions.trim() } : {}),
      };
      const readable: any = {
        ...(protocol === 'mcp' ? { mcpUrl: trimmed } : { agentCardUrl: trimmed }),
        planner: { id: 'scenario-v0.3', mode: 'approve' as const },
        planners: { ['scenario-v0.3']: { seed } },
        llm: { provider: 'server', model: selectedModel || '' },
      };
      return `/client/#${JSON.stringify(readable)}`;
    } catch { return ''; }
  }, [serverUrl, scenario, scenarioId, role, selectedModel, instructions, protocol]);

  // (Removed) Live preview URL; Step 3 should not show a server endpoint

  if (loading) return <div className="p-6 text-slate-600">Loading…</div>;
  if (error) return <div className="p-6 text-rose-700">Error: {error}</div>;
  if (!scenario) return <div className="p-6">Scenario not found</div>;

  const cfg = scenario.config || scenario;
  const scenarioTitle = cfg?.metadata?.title || scenario.name || scenarioId;

  return (
      <div className="space-y-4">
        {/* Step 1: Role */}
        <Card className="space-y-3">
          <CardHeader title="Step 1: Choose Your Role" />
          {cfg?.metadata?.description && (
            <div className="text-sm text-slate-700">{cfg.metadata.description}</div>
          )}
          <div className="text-sm text-slate-600">Which agent will you provide?</div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {agentIds.map((id) => {
              const a = (scenario?.config?.agents || []).find((x: any) => x.agentId === id) || {};
              const principal = a?.principal || {};
              const principalLine = [principal?.name, principal?.type].filter(Boolean).join(' • ');
              const situation: string = (a?.situation || '').toString();
              const situationShort = situation ? (situation.length > 140 ? situation.slice(0, 140) + '…' : situation) : '';
              const toolNames: string[] = Array.isArray(a?.tools) ? a.tools.map((t: any) => String(t?.toolName || t?.name || '')).filter(Boolean) : [];
              return (
                <label key={id} className={`p-3 rounded-lg border-2 cursor-pointer ${role === id ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
                  <div className="flex items-center gap-2">
                    <input type="radio" name="role" checked={role === id} onChange={() => { setRole(id); }} />
                    <div className="font-medium">{id}</div>
                  </div>
                  {principalLine && (
                    <div className="text-xs text-slate-600 mt-1">{principalLine}</div>
                  )}
                  {principal?.description && (
                    <div className="text-xs text-slate-600 mt-1">{principal.description}</div>
                  )}
                  {toolNames.length > 0 && (
                    <div className="text-xs text-slate-600 mt-1">
                      <span className="font-medium">Tools:</span> {toolNames.join(', ')}
                    </div>
                  )}
                </label>
              );
            })}
          </div>
          
        </Card>

        {/* Step 2: Connection */}
        <Card className={`space-y-3`}>
          <CardHeader title="Step 2: Choose Your Connection Pattern" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" role="radiogroup" aria-label="Connection pattern">
            <div
              className={`rounded-lg p-4 border-2 ${hasClient ? 'border-blue-600 bg-blue-50' : 'border-gray-200'} cursor-pointer`}
              role="radio"
              aria-checked={hasClient}
              tabIndex={0}
              onClick={() => { setHasClient(true); }}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setHasClient(true); } }}
            >
              <label className="font-bold flex items-center gap-2">
                <input type="radio" name="pattern" checked={hasClient} onChange={() => setHasClient(true)} />
                I have a Client
              </label>
              <p className="text-sm text-slate-600 mt-1">Platform provides a server endpoint for your client.</p>
            </div>
            <div
              className={`rounded-lg p-4 border-2 ${!hasClient ? 'border-blue-600 bg-blue-50' : 'border-gray-200'} cursor-pointer`}
              role="radio"
              aria-checked={!hasClient}
              tabIndex={0}
              onClick={() => { setHasClient(false); }}
              onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setHasClient(false); } }}
            >
              <label className="font-bold flex items-center gap-2">
                <input type="radio" name="pattern" checked={!hasClient} onChange={() => setHasClient(false)} />
                I have a Server
              </label>
              <p className="text-sm text-slate-600 mt-1">Platform launches a client to connect to you.</p>
            </div>
          </div>
        </Card>

        {/* Step 3: Protocol */}
        <Card className="space-y-3">
          <CardHeader title="Step 3: Choose Protocol" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className={`p-3 rounded-lg border-2 cursor-pointer ${protocol === 'a2a' ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
              <div className="flex items-center gap-2">
                <input type="radio" name="protocol" checked={protocol === 'a2a'} onChange={() => setProtocol('a2a')} />
                <div className="font-medium">Use A2A Protocol</div>
              </div>
              <div className="text-sm text-slate-600 mt-1">JSON‑RPC with optional SSE streaming; aligns with A2A.</div>
            </label>
            <label className={`p-3 rounded-lg border-2 cursor-pointer ${protocol === 'mcp' ? 'border-blue-600 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
              <div className="flex items-center gap-2">
                <input type="radio" name="protocol" checked={protocol === 'mcp'} onChange={() => setProtocol('mcp')} />
                <div className="font-medium">Use MCP Protocol</div>
              </div>
              <div className="text-sm text-slate-600 mt-1">Model Context Protocol with tool-based interactions.</div>
            </label>
          </div>
          {/* If the participant has a server, ask for its URL */}
          {!hasClient && (
            <div className="space-y-2 mt-2">
              <label className="text-sm text-slate-700 font-medium">
                {protocol === 'mcp'
                  ? 'Your MCP Server URL (must support Streamable HTTP Transport + 3 Language-First Interop Tools — begin_chat_thread, send_message_to_chat_thread, check_replies)'
                  : 'Your Agent Card URL'}
              </label>
              <input
                className="w-full border rounded px-2 py-2 text-sm bg-white"
                placeholder={protocol === 'mcp' ? 'e.g., https://your-host.example.com/mcp' : 'e.g., https://your-host.example.com/.well-known/agent-card.json'}
                value={serverUrl}
                onChange={(e) => setServerUrl(e.target.value)}
              />
              <div className="text-xs text-slate-600">
                {protocol === 'mcp'
                  ? 'The scenarios client will connect to this MCP endpoint.'
                  : 'The scenarios client will resolve the JSON-RPC endpoint from this Agent Card.'}
              </div>
            </div>
          )}
        </Card>

        {/* Step 4: Simulated agent config */}
        <Card className="space-y-3">
          <CardHeader title="Step 4: Configure the Simulated Agent" />
          <div className="text-sm text-slate-600">Platform will simulate: <span className="font-mono">{simulatedAgentId || '(choose role first)'}</span></div>
          <div className="space-y-3">
            <div className="space-y-1">
              <label htmlFor="run-llm-model" className="text-sm text-slate-600">LLM Model</label>
              <ModelSelect
                id="run-llm-model"
                providers={providers}
                value={selectedModel}
                onChange={(v) => setSelectedModel(v)}
                className="w-full border rounded px-2 py-1 bg-white"
              />
            </div>
            <div className="space-y-1">
                <label htmlFor="run-additional-instructions" className="text-sm text-slate-600">Additional Instructions</label>
                <textarea
                  id="run-additional-instructions"
                  className="w-full border rounded px-2 py-2 text-sm bg-white"
                  rows={3}
                  placeholder="Optional guidance for the simulated agent"
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                />
              </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3" style={{ display: 'none' }}>
                {agentIds.map((id) => (
                  <div key={id} className="space-y-1">
                    <div className="text-sm text-slate-700 font-medium">{id} Instructions</div>
                    <textarea
                      className="w-full border rounded px-2 py-2 text-sm bg-white"
                      rows={4}
                      placeholder={`Optional guidance for ${id}`}
                      value={agentInstructions[id] || ''}
                      onChange={(e) => setAgentInstructions((prev) => ({ ...prev, [id]: e.target.value }))}
                    />
                  </div>
                ))}
                <div className="space-y-1 md:col-span-2">
                  <div className="text-sm text-slate-700 font-medium">Starting Agent</div>
                  <div className="flex gap-4 text-sm text-slate-700">
                    {agentIds.map((id) => (
                      <label key={`start-${id}`} className="flex items-center gap-2">
                        <input type="radio" name="start-first" checked={startFirst === id} onChange={() => setStartFirst(id)} />
                        {id}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
          </div>
        </Card>

        {/* Action Buttons */}
        <Card className="p-4 bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
          {(() => {
            if (false) {
              // Simulation mode - direct client launch
              const config64ForSim = encodeBase64Url(buildMeta());
              const base = api.getBaseUrl();
              const apiBase = `${base}/api`;
              const { label: endpointLabel, url: serverUrl } = buildBridgeEndpoint(apiBase, protocol, config64ForSim);
              const cfg = (scenario?.config || scenario);
              const agents: string[] = (cfg?.agents || []).map((a: any) => a.agentId);
              const plannerId = startFirst || agents[0] || '';
              const counterpart = agents.find(a => a !== plannerId) || '';
              const params = new URLSearchParams({
                scenarioUrl: `${base}/api/scenarios/${encodeURIComponent(String(scenarioId!))}`,
                plannerAgentId: plannerId,
                counterpartAgentId: counterpart,
                endpoint: serverUrl,
              });
              if (selectedModel) {
                params.set('defaultModel', selectedModel);
              }
              if (instructions && instructions.trim()) {
                params.set('instructions', instructions.trim());
              }
              const href = `/client/#/?${params.toString()}`;
              
              return (
                <div className="space-y-3">
                  <h3 className="text-lg font-semibold text-slate-800">Ready to Launch</h3>
                  <div className="text-sm text-slate-600 bg-white rounded p-3 border border-slate-200">
                    <div className="font-medium mb-1">{endpointLabel}:</div>
                    <div className="font-mono text-xs break-all text-slate-500">{serverUrl}</div>
                  </div>
                  <Button 
                    as="a" 
                    href={href} 
                    target="_blank" 
                    rel="noreferrer" 
                    variant="primary"
                    className="w-full bg-gradient-to-r from-green-600 to-emerald-600 hover:from-green-700 hover:to-emerald-700 text-white font-semibold py-4 px-6 rounded-lg shadow-lg transition-colors text-lg"
                  >
                    🚀 Launch Simulation Client
                  </Button>
                  <p className="text-xs text-slate-600 text-center">
                    Opens in a new tab with all settings pre-configured
                  </p>
                </div>
              );
            } else if (hasClient) {
              // Client mode - launch monitoring page (link with href for right-click & inspection)
              return (
                <div className="space-y-3">
                  <h3 className="text-lg font-semibold text-slate-800">Ready to Connect</h3>
                  <a
                    href={computedRoomHref || '#'}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center justify-center w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-semibold py-4 px-6 rounded-lg shadow-lg transition-colors text-lg"
                    onClick={(e)=>{ if (!computedRoomHref) e.preventDefault(); }}
                  >
                    📊 Open Server Manager
                  </a>
                  <p className="text-xs text-slate-600 text-center">
                    Configure server endpoint and monitor connection
                  </p>
                </div>
              );
      } else {
        // Server mode - open client (use proper link with href for copy/right-click)
        const href = computedClientHref;
        return (
          <div className="space-y-3">
            <h3 className="text-lg font-semibold text-slate-800">Ready to Connect</h3>
            <a
              href={href || '#'}
              target="_blank"
              rel="noreferrer"
              className={`inline-flex items-center justify-center w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold py-4 px-6 rounded-lg shadow-lg transition-colors text-lg ${!href ? 'opacity-60 pointer-events-none' : ''}`}
              onClick={(e)=>{ if (!href) e.preventDefault(); }}
            >
              💬 Open Client & Connect
            </a>
            <p className="text-xs text-slate-600 text-center">
              Opens client in new tab to connect to your server
            </p>
          </div>
        );
      }
          })()}
        </Card>
      </div>
  );
}
