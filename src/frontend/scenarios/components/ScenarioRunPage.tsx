import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Card, CardHeader, Button } from '../../ui';
import { api } from '../utils/api';
import { RUN_MODES, RunModeKey } from '../constants/runModes';

function encodeBase64Url(obj: unknown): string {
  const json = JSON.stringify(obj);
  const base64 = btoa(json).replace(/=+$/, '');
  return base64.replace(/\+/g, '-').replace(/\//g, '_');
}

export function ScenarioRunPage() {
  const { scenarioId } = useParams<{ scenarioId: string }>();
  const navigate = useNavigate();
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [scenario, setScenario] = useState<any | null>(null);
  const [runMode, setRunMode] = useState<RunModeKey>(() => {
    try {
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      const mode = params.get('mode');
      // Handle different plugin modes
      if (mode === 'plugin' || mode === 'mcp' || mode === 'mcp-client') return 'mcp-client';
      if (mode === 'mcp-server') return 'mcp-server';
      if (mode === 'a2a' || mode === 'a2a-client') return 'a2a-client';
      if (mode === 'a2a-server') return 'a2a-server';
      // If no mode in URL, default to 'internal' (when coming from "Run" button)
      return 'internal';
    } catch { return 'internal'; }
  });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startingAgentId, setStartingAgentId] = useState<string>('');
  const [providers, setProviders] = useState<Array<{ name: string; models: string[] }>>([]);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [agentSystemExtra, setAgentSystemExtra] = useState<Record<string, string>>({});
  const [agentInitiatingExtra, setAgentInitiatingExtra] = useState<Record<string, string>>({});
  // Autostart selection removed; we now start agents from the Created page per‑agent

  // Keep URL hash query param `mode` in sync with selected run mode so deep links update.
  useEffect(() => {
    try {
      const u = new URL(window.location.href);
      const hash = u.hash || '';
      const base = hash && hash.includes('?') ? hash.slice(0, hash.indexOf('?')) : (hash || '#/');
      const qs = new URLSearchParams(hash && hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '');
      // Map runMode to compact mode values
      const modeValue = runMode.includes('mcp') ? 'mcp'
        : runMode.includes('a2a') ? 'a2a'
        : 'internal';
      qs.set('mode', modeValue);
      const newHash = base + (qs.toString() ? `?${qs.toString()}` : '');
      const newUrl = `${u.origin}${u.pathname}${newHash}`;
      if (newUrl !== window.location.href) history.replaceState(null, '', newUrl);
    } catch {}
  }, [runMode]);

  useEffect(() => {
    (async () => {
      try {
        setIsLoading(true);
        const res = await api.getScenario(scenarioId!);
        if (res.success) {
          const s = res.data;
          setScenario(s);
          const cfg = s.config || s;
          const defaultTitle = cfg?.metadata?.title || s.name || '';
          const modeLabel = {
            'internal': 'Internal',
            'mcp-client': 'External MCP Client',
            'mcp-server': 'External MCP Server',
            'a2a-client': 'External A2A Client',
            'a2a-server': 'External A2A Server'
          }[runMode] || 'Unknown';
          setTitle(defaultTitle ? `${defaultTitle} - ${modeLabel}` : (runMode === 'internal' ? 'Internal Run' : (runMode === 'mcp' ? 'MCP Client Run' : 'A2A Client Run')));
          const firstId = (cfg?.agents?.[0]?.agentId) || '';
          setStartingAgentId(firstId);
          // Load providers and build model options
          try {
            const p = await api.getLLMConfig();
            if (p.success) {
              const filtered = (p.data.providers || []).filter((x: any) =>
                x.name !== 'browserside' &&
                x.name !== 'mock' &&
                x.available !== false
              );
              // Prefer OpenRouter and put it first if available
              const openrouter = filtered.find((x: any) => x.name === 'openrouter');
              const others = filtered.filter((x: any) => x.name !== 'openrouter');
              const ordered = openrouter ? [openrouter, ...others] : filtered;
              setProviders(ordered);
              // Build model list preferring OpenRouter's preset when present
              const flat = ordered.flatMap((x: any) => x.models || []);
              // Ensure @preset/banterop is the first option if available
              const hasPreset = flat.includes('@preset/banterop');
              const ordFlat = hasPreset ? ['@preset/banterop', ...flat.filter((m: string) => m !== '@preset/banterop')] : flat;
              setModelOptions(ordFlat);
              // Initialize per-agent model selection with preferred default
              const defaultModel = ordFlat.includes('@preset/banterop') ? '@preset/banterop' : (ordFlat[0] || '');
              const initial: Record<string, string> = {};
              for (const a of cfg.agents || []) initial[a.agentId] = defaultModel;
              setAgentModels(initial);
            }
          } catch {
            // ignore provider errors; leave lists empty
          }
        } else {
          setError('Failed to load scenario');
        }
      } catch (e: any) {
        setError(e?.message || 'Failed to load scenario');
      } finally {
        setIsLoading(false);
      }
    })();
  }, [scenarioId]);

  useEffect(() => {
    if (!scenario) return;
    const cfg = scenario.config || scenario;
    const base = cfg?.metadata?.title || scenario.name || '';
    const modeLabel = {
      'internal': 'Internal',
      'mcp-client': 'External MCP Client',
      'mcp-server': 'External MCP Server',
      'a2a-client': 'External A2A Client',
      'a2a-server': 'External A2A Server'
    }[runMode] || 'Unknown';
    setTitle(base ? `${base} - ${modeLabel}` : `${modeLabel} Run`);
  }, [runMode, scenario]);

  const agentOptions = useMemo(() => (scenario?.config?.agents || []).map((a: any) => a.agentId), [scenario]);

  useEffect(() => {
    try { 
      const launchType = runMode.includes('mcp') ? 'mcp' : runMode.includes('a2a') ? 'a2a' : 'watch';
      localStorage.setItem('scenarioLauncher.launchType', launchType); 
    } catch {}
  }, [runMode]);

  const buildMeta = () => {
    const cfg = scenario.config;
    const externalId = runMode !== 'internal' ? startingAgentId : null;
    const agents = (cfg.agents || []).map((a: any) => {
      const isExternal = externalId && a.agentId === externalId;
      const model = modelOptions.length ? (agentModels[a.agentId] || modelOptions[0] || '') : undefined;
      const systemPromptExtra = (agentSystemExtra[a.agentId] || '').trim();
      const initiatingMessageExtra = (agentInitiatingExtra[a.agentId] || '').trim();
      const config: Record<string, unknown> = {};
      // Only include model/extras for internal agents; omit for external client agent in MCP/A2A modes
      if (!isExternal) {
        if (model) config.model = model;
        if (systemPromptExtra) config.systemPromptExtra = systemPromptExtra;
        if (initiatingMessageExtra) config.initiatingMessageExtra = initiatingMessageExtra;
      }
      return Object.keys(config).length ? { id: a.agentId, config } : { id: a.agentId };
    });
    return {
      title,
      description,
      scenarioId: cfg?.metadata?.id || scenarioId,
      agents,
      startingAgentId,
    };
  };

  const continueInternal = async () => {
    const meta = buildMeta();
    try { localStorage.setItem('scenarioLauncher.runMode', 'client'); } catch {}
    // Create the conversation immediately so the next page references it by id
    try {
      const res = await apiCallCreateConversation({ meta });
      navigate(`/scenarios/created/${res.conversationId}`);
    } catch (e) {
      alert(`Failed to start conversation: ${e}`);
    }
  };

  const continuePlugin = () => {
    const meta = buildMeta();
    const config64 = encodeBase64Url(meta);
    
    switch(runMode) {
      case 'mcp-client':
        navigate(`/scenarios/${encodeURIComponent(scenarioId!)}/external-mcp-client/${config64}`);
        break;
      case 'mcp-server':
        // TODO: Implement MCP server mode
        navigate(`/scenarios/${encodeURIComponent(scenarioId!)}/external-mcp-server/${config64}`);
        break;
      case 'a2a-client':
        navigate(`/scenarios/${encodeURIComponent(scenarioId!)}/external-a2a-client/${config64}`);
        break;
      case 'a2a-server':
        // TODO: Implement A2A server mode
        navigate(`/scenarios/${encodeURIComponent(scenarioId!)}/external-a2a-server/${config64}`);
        break;
      default:
        alert('Unknown mode: ' + runMode);
    }
  };

  if (isLoading) return <div className="p-6 text-slate-600">Loading…</div>;
  if (error) return <div className="p-6 text-rose-700">Error: {error}</div>;
  if (!scenario) return <div className="p-6">Scenario not found</div>;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{scenario.config?.metadata?.title || scenario.name}</h1>
        <div className="text-sm text-slate-500">{scenario.config?.metadata?.id}</div>
      </div>

      <Card className="space-y-4">
        <CardHeader title="Run Options" />
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {Object.entries(RUN_MODES).map(([key, mode]) => (
            <div 
              key={key}
              className={`p-3 border-2 rounded ${
                mode.disabled 
                  ? 'border-gray-200 bg-gray-50 opacity-50 cursor-not-allowed' 
                  : runMode===key
                    ? 'border-primary bg-primary-50 cursor-pointer'
                    : 'border-gray-200 hover:border-gray-300 cursor-pointer'
              }`} 
              onClick={() => !mode.disabled && setRunMode(key as RunModeKey)}
            >
              <div className={`font-medium ${mode.disabled ? 'text-gray-500' : ''}`}>
                {mode.label} {mode.disabled && '(Coming soon)'}
              </div>
              <div className="text-xs text-slate-600">{mode.description}</div>
            </div>
          ))}
        </div>
        
        {/* Mode description */}
        <div className="p-3 rounded-lg text-xs bg-primary-50 text-primary-800">
          {runMode === 'internal' && "Both agents will be simulated internally by this platform. You'll watch the conversation unfold between simulated agents using the models you configure below."}
          {runMode === 'mcp-client' && "Plug in an external MCP client (like Claude Desktop) to act as one agent. This platform will simulate the other agent and provide an MCP server for your client to connect to."}
          {runMode === 'mcp-server' && "Plug in an external MCP server. This platform will simulate an MCP client that connects to your external MCP server."}
          {runMode === 'a2a-client' && "Plug in an external A2A client to act as one agent. This platform will simulate the other agent and provide an A2A endpoint for your client to connect to."}
          {runMode === 'a2a-server' && "Plug in an external A2A server. This platform will simulate an A2A client that connects to your external A2A endpoint."}
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Conversation Title</label>
          <input className="w-full border border-border rounded-2xl px-3 py-2 bg-panel text-text" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Description (optional)</label>
          <textarea className="w-full border border-border rounded-2xl px-3 py-2 bg-panel text-text" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">{runMode !== 'internal' ? `External Agent (${runMode.toUpperCase().replace('-', ' ')})` : 'Starting Agent'}</label>
          <select className="w-full border border-border rounded-2xl px-3 py-2 bg-panel text-text" value={startingAgentId} onChange={(e) => setStartingAgentId(e.target.value)}>
            {agentOptions.map((id: string) => (<option key={id} value={id}>{id}</option>))}
          </select>
        </div>

        {/* Agent model configuration (from Scenario Launcher) */}
        {modelOptions.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Agent Configuration</div>
            <div className="space-y-4">
              {(scenario?.config?.agents || []).filter((a: any) => !(runMode !== 'internal' && a.agentId === startingAgentId)).map((a: any) => (
                <Card key={a.agentId} className="space-y-2">
                  <div className="text-sm font-medium text-slate-700 break-all">{a.agentId}</div>
                  <div className="grid grid-cols-3 items-center gap-2">
                    <div className="col-span-1 text-xs text-slate-600">Model</div>
                    <div className="col-span-2">
                      <select
                        className="w-full border border-border rounded-2xl px-2 py-1 text-sm bg-panel text-text"
                        value={agentModels[a.agentId] || modelOptions[0] || ''}
                        onChange={(e) => setAgentModels((m) => ({ ...m, [a.agentId]: e.target.value }))}
                      >
                        {providers.map((p) => (
                          <optgroup key={p.name} label={p.name}>
                            {p.models.map((m) => (<option key={`${p.name}:${m}`} value={m}>{m}</option>))}
                          </optgroup>
                        ))}
                      </select>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 items-start gap-2">
                    <label className="col-span-1 text-xs text-slate-600">Additional system prompt</label>
                    <div className="col-span-2">
                      <textarea
                        className="w-full border border-border rounded-2xl px-2 py-1 text-xs bg-panel text-text"
                        rows={2}
                        placeholder="Optional text appended to this agent's system prompt"
                        value={agentSystemExtra[a.agentId] || ''}
                        onChange={(e) => setAgentSystemExtra((m) => ({ ...m, [a.agentId]: e.target.value }))}
                      />
                    </div>
                  </div>
                  <div className="grid grid-cols-3 items-start gap-2">
                    <label className="col-span-1 text-xs text-slate-600">Initiating message extra</label>
                    <div className="col-span-2">
                      <textarea
                        className="w-full border border-border rounded-2xl px-2 py-1 text-xs bg-panel text-text"
                        rows={2}
                        placeholder="Optional text appended to the initiating message for this agent"
                        value={agentInitiatingExtra[a.agentId] || ''}
                        onChange={(e) => setAgentInitiatingExtra((m) => ({ ...m, [a.agentId]: e.target.value }))}
                      />
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          </div>
        )}

        {/* Autostart selection removed */}

        <div className="pt-2">
          {runMode === 'internal' ? (
            <Button variant="primary" className="w-full" onClick={continueInternal}>Start Conversation</Button>
          ) : (
            <Button variant="primary" className="w-full" onClick={continuePlugin}>
              Continue to {runMode.includes('mcp') ? 'MCP' : 'A2A'} {runMode.includes('server') ? 'Server' : 'Client'} Configuration
            </Button>
          )}
        </div>
      </Card>
    </div>
  );
}

// Lightweight helper using the same WS JSON-RPC pattern as elsewhere in this app
async function apiCallCreateConversation(params: any): Promise<{ conversationId: number }> {
  return new Promise((resolve, reject) => {
    const API_BASE: string =
      (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.API_BASE) ||
      'http://localhost:3000/api';
    const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID();
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method: 'createConversation', params }));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id !== id) return;
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result as { conversationId: number });
    };
    ws.onerror = (e) => reject(e);
  });
}
