import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { Card, CardHeader, Button, ModelSelect } from '../../ui';
import { api } from '../utils/api';

type Protocol = 'a2a' | 'mcp';

function encodeBase64Url(obj: unknown): string {
  const json = JSON.stringify(obj);
  const base64 = btoa(json).replace(/=+$/, '');
  return base64.replace(/\+/g, '-').replace(/\//g, '_');
}

export function RunWizardPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const navigate = useNavigate();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<any | null>(null);

  // Step 1: Choose your role or internal simulation
  const [role, setRole] = useState<string>('');
  const [internalSim, setInternalSim] = useState<boolean>(false);

  // Step 2: Choose connection pattern
  const [hasClient, setHasClient] = useState<boolean>(true);
  const [protocol, setProtocol] = useState<Protocol>('a2a');

  // Step 3/4: Configure simulated agent(s)
  const [providers, setProviders] = useState<Array<{ name: string; models: string[] }>>([]);
  const [selectedModel, setSelectedModel] = useState<string>('');
  const [instructions, setInstructions] = useState<string>('');
  const [agentInstructions, setAgentInstructions] = useState<Record<string, string>>({});
  const [startFirst, setStartFirst] = useState<string>('');
  const [generatedConfig64, setGeneratedConfig64] = useState<string>('');

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
        setStartFirst(firstId);
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
            setProviders(filtered);
            const flat = filtered.flatMap((x: any) => x.models || []);
            if (flat[0]) setSelectedModel(flat[0]);
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

  // Helper function to build metadata for simulation
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
      startingAgentId: startFirst || agents[0]?.id || '',
    };
  };

  const onLaunch = () => {
    // Only used for non-simulation modes now
    if (internalSim) return;
    const cfg = scenario?.config || scenario;
    const title = cfg?.metadata?.title || scenario?.name || '';
    const sid = cfg?.metadata?.id || scenarioId;
    const agents = (cfg?.agents || []).map((a: any) => {
      const isExternal = hasClient ? a.agentId === role : a.agentId === simulatedAgentId;
      const conf: Record<string, unknown> = {};
      if (!isExternal) {
        if (selectedModel) conf.model = selectedModel;
        if (instructions.trim()) conf.systemPromptExtra = instructions.trim();
      }
      return Object.keys(conf).length ? { id: a.agentId, config: conf } : { id: a.agentId };
    });

    const meta = {
      title: `Run: ${title}`,
      scenarioId: sid,
      agents,
      startingAgentId: role,
    };

    if (hasClient) {
      // Outcome A: participant has a CLIENT → open pre-launch monitoring page in a new tab
      const config64 = encodeBase64Url(meta);
      const url = protocol === 'a2a'
        ? `/#/scenarios/${encodeURIComponent(sid!)}/external-a2a-client/${config64}`
        : `/#/scenarios/${encodeURIComponent(sid!)}/external-mcp-client/${config64}`;
      try { window.open(url, '_blank'); } catch { navigate(url); }
    } else {
      // Outcome B: participant has a SERVER → open client prefilled
      const base = api.getBaseUrl();
      const scenarioUrl = `${base}/api/scenarios/${encodeURIComponent(String(sid))}`;
      const params = new URLSearchParams({
        scenarioUrl,
        plannerAgentId: simulatedAgentId || '',
        counterpartAgentId: role || '',
      });
      // Add the selected model if one is chosen
      if (selectedModel) {
        params.set('defaultModel', selectedModel);
      }
      window.open(`/client/#/?${params.toString()}`, '_blank');
    }
  };

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
                    <input type="radio" name="role" checked={!internalSim && role === id} onChange={() => { setInternalSim(false); setRole(id); }} />
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
          <label className="flex items-center gap-2 text-xs text-slate-700 mt-2">
            <input type="checkbox" checked={internalSim} onChange={(e) => { setInternalSim(e.target.checked); if (e.target.checked) setRole(''); }} />
            I won’t provide an agent; I just want to run a simulation.
          </label>
        </Card>

        {/* Step 2: Connection */}
        <Card className={`space-y-3 ${internalSim ? 'opacity-50' : ''}`}>
          <CardHeader title="Step 2: Choose Your Connection Pattern" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4" role="radiogroup" aria-label="Connection pattern">
            <div
              className={`rounded-lg p-4 border-2 ${!internalSim && hasClient ? 'border-blue-600 bg-blue-50' : 'border-gray-200'} ${internalSim ? 'cursor-default' : 'cursor-pointer'}`}
              role="radio"
              aria-checked={!internalSim && hasClient}
              tabIndex={internalSim ? -1 : 0}
              onClick={() => { if (!internalSim) setHasClient(true); }}
              onKeyDown={(e) => { if (!internalSim && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setHasClient(true); } }}
            >
              <label className="font-bold flex items-center gap-2">
                <input type="radio" name="pattern" checked={!internalSim && hasClient} onChange={() => setHasClient(true)} disabled={internalSim} />
                I have a Client
              </label>
              <p className="text-sm text-slate-600 mt-1">Platform provides a server endpoint for your client.</p>
            </div>
            <div
              className={`rounded-lg p-4 border-2 ${!internalSim && !hasClient ? 'border-blue-600 bg-blue-50' : 'border-gray-200'} ${internalSim ? 'cursor-default' : 'cursor-pointer'}`}
              role="radio"
              aria-checked={!internalSim && !hasClient}
              tabIndex={internalSim ? -1 : 0}
              onClick={() => { if (!internalSim) setHasClient(false); }}
              onKeyDown={(e) => { if (!internalSim && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); setHasClient(false); } }}
            >
              <label className="font-bold flex items-center gap-2">
                <input type="radio" name="pattern" checked={!internalSim && !hasClient} onChange={() => setHasClient(false)} disabled={internalSim} />
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

          {/* Removed Simulation Server Endpoint preview from Step 3 */}
        </Card>

        {/* Step 4: Simulated agent config */}
        <Card className="space-y-3">
          <CardHeader title={internalSim ? "Step 4: Configure Simulated Agents" : "Step 4: Configure the Simulated Agent"} />
          {!internalSim && (
            <div className="text-sm text-slate-600">Platform will simulate: <span className="font-mono">{simulatedAgentId || '(choose role first)'}</span></div>
          )}
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
            {!internalSim ? (
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
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
            )}
          </div>
        </Card>

        {/* Action Buttons */}
        <Card className="p-4 bg-gradient-to-br from-blue-50 to-indigo-50 border-blue-200">
          {(() => {
            if (internalSim) {
              // Simulation mode - direct client launch
              const config64ForSim = encodeBase64Url(buildMeta());
              const base = api.getBaseUrl();
              const serverUrl = protocol === 'mcp'
                ? `${base}/api/bridge/${config64ForSim}/mcp`
                : `${base}/api/bridge/${config64ForSim}/a2a/.well-known/agent-card.json`;
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
              const href = `/client/#/?${params.toString()}`;
              
              return (
                <div className="space-y-3">
                  <h3 className="text-lg font-semibold text-slate-800">Ready to Launch</h3>
                  <div className="text-sm text-slate-600 bg-white rounded p-3 border border-slate-200">
                    <div className="font-medium mb-1">Simulation Server Endpoint:</div>
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
              // Client mode - launch monitoring page
              return (
                <div className="space-y-3">
                  <h3 className="text-lg font-semibold text-slate-800">Ready to Connect</h3>
                  <Button 
                    variant="primary"
                    className="w-full bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-semibold py-4 px-6 rounded-lg shadow-lg transition-colors text-lg"
                    onClick={onLaunch}
                  >
                    📊 Open Server Manager
                  </Button>
                  <p className="text-xs text-slate-600 text-center">
                    Configure server endpoint and monitor connection
                  </p>
                </div>
              );
            } else {
              // Server mode - open client
              return (
                <div className="space-y-3">
                  <h3 className="text-lg font-semibold text-slate-800">Ready to Connect</h3>
                  <Button 
                    variant="primary"
                    className="w-full bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-700 hover:to-indigo-700 text-white font-semibold py-4 px-6 rounded-lg shadow-lg transition-colors text-lg"
                    onClick={onLaunch}
                  >
                    💬 Open Client & Connect
                  </Button>
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
