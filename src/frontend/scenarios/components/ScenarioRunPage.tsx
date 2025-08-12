import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../utils/api';

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
  const [runMode, setRunMode] = useState<'internal'|'plugin'>(() => {
    try { return (localStorage.getItem('scenarioLauncher.launchType') === 'plugin') ? 'plugin' : 'internal'; } catch { return 'internal'; }
  });
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [startingAgentId, setStartingAgentId] = useState<string>('');
  const [providers, setProviders] = useState<Array<{ name: string; models: string[] }>>([]);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [agentModels, setAgentModels] = useState<Record<string, string>>({});
  const [autostart, setAutostart] = useState<'none'|'client'|'server'>('none');

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
          setTitle(defaultTitle ? `${defaultTitle} - ${runMode === 'plugin' ? 'Plugin' : 'Run'}` : (runMode === 'plugin' ? 'MCP Plugin' : 'Test Run'));
          const firstId = (cfg?.agents?.[0]?.agentId) || '';
          setStartingAgentId(firstId);
          // Load providers and build model options
          try {
            const p = await api.getLLMConfig();
            if (p.success) {
              const filtered = (p.data.providers || []).filter((x: any) => x.name !== 'browserside' && x.name !== 'mock');
              setProviders(filtered);
              const flat = filtered.flatMap((x: any) => x.models || []);
              setModelOptions(flat);
              // Initialize agent models
              const initial: Record<string, string> = {};
              for (const a of cfg.agents || []) {
                initial[a.agentId] = flat[0] || '';
              }
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
    setTitle(base ? `${base} - ${runMode === 'plugin' ? 'Plugin' : 'Run'}` : (runMode === 'plugin' ? 'MCP Plugin' : 'Test Run'));
  }, [runMode, scenario]);

  const agentOptions = useMemo(() => (scenario?.config?.agents || []).map((a: any) => a.agentId), [scenario]);

  useEffect(() => {
    try { localStorage.setItem('scenarioLauncher.launchType', runMode === 'plugin' ? 'plugin' : 'watch'); } catch {}
  }, [runMode]);

  const buildMeta = () => {
    const cfg = scenario.config;
    const humanize = (id: string) => id.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const agents = (cfg.agents || []).map((a: any) => ({
      id: a.agentId,
      displayName: a.principal?.name || humanize(a.agentId),
      config: modelOptions.length ? { model: agentModels[a.agentId] || modelOptions[0] || '' } : undefined,
    }));
    return {
      title,
      description,
      scenarioId: cfg?.metadata?.id || scenarioId,
      agents,
      startingAgentId,
      custom: autostart !== 'none' ? { autoRun: true, autostartMode: autostart } : undefined,
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
    const config64 = encodeBase64Url(meta); // MCP bridge expects ConversationMeta directly
    navigate(`/scenarios/${encodeURIComponent(scenarioId!)}/plug-in/${config64}`);
  };

  if (isLoading) return <div className="p-6 text-slate-600">Loading…</div>;
  if (error) return <div className="p-6 text-rose-700">Error: {error}</div>;
  if (!scenario) return <div className="p-6">Scenario not found</div>;

  return (
    <div className="max-w-4xl mx-auto p-6 space-y-6">
      <div>
        <nav className="text-sm text-slate-600 mb-1">
          <Link to="/scenarios" className="hover:underline">Scenarios</Link>
          <span className="mx-1">/</span>
          <Link to={`/scenarios/${encodeURIComponent(scenarioId!)}`} className="hover:underline">{scenario.config?.metadata?.title || scenario.name}</Link>
          <span className="mx-1">/</span>
          <span className="text-slate-500">Run</span>
        </nav>
        <h1 className="text-2xl font-semibold">{scenario.config?.metadata?.title || scenario.name}</h1>
        <div className="text-sm text-slate-500">{scenario.config?.metadata?.id}</div>
      </div>

      <div className="bg-white border rounded p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <div className={`p-3 border-2 rounded cursor-pointer ${runMode==='internal'?'border-blue-600 bg-blue-50':'border-gray-200 hover:border-gray-300'}`} onClick={() => setRunMode('internal')}>
            <div className="font-medium">Run Internally</div>
            <div className="text-xs text-slate-600">Simulate with internal agents</div>
          </div>
          <div className={`p-3 border-2 rounded cursor-pointer ${runMode==='plugin'?'border-blue-600 bg-blue-50':'border-gray-200 hover:border-gray-300'}`} onClick={() => setRunMode('plugin')}>
            <div className="font-medium">Plug In (MCP)</div>
            <div className="text-xs text-slate-600">Connect external MCP client</div>
          </div>
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Conversation Title</label>
          <input className="w-full border rounded px-3 py-2" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Description (optional)</label>
          <textarea className="w-full border rounded px-3 py-2" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">{runMode === 'plugin' ? 'External Agent (MCP client)' : 'Starting Agent'}</label>
          <select className="w-full border rounded px-3 py-2" value={startingAgentId} onChange={(e) => setStartingAgentId(e.target.value)}>
            {agentOptions.map((id: string) => (<option key={id} value={id}>{id}</option>))}
          </select>
        </div>

        {/* Agent model configuration (from Scenario Launcher) */}
        {modelOptions.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Agent Models</div>
            <div className="space-y-2">
              {(scenario?.config?.agents || []).filter((a: any) => !(runMode === 'plugin' && a.agentId === startingAgentId)).map((a: any) => (
                <div key={a.agentId} className="grid grid-cols-3 items-center gap-2">
                  <div className="col-span-1 text-sm text-slate-700 break-all">{a.agentId}</div>
                  <div className="col-span-2">
                    <select
                      className="w-full border rounded px-2 py-1 text-sm"
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
              ))}
            </div>
          </div>
        )}

        {/* Autostart behavior akin to scenario launcher */}
        {runMode === 'internal' && (
          <div>
            <label className="block text-sm text-slate-700 mb-1">Autostart Agents</label>
            <select className="w-full border rounded px-3 py-2" value={autostart} onChange={(e) => setAutostart(e.target.value as any)}>
              <option value="none">Do not autostart</option>
              <option value="client">Autostart in browser</option>
              <option value="server">Autostart on server</option>
            </select>
          </div>
        )}

        <div className="pt-2">
          {runMode === 'internal' ? (
            <button className="w-full bg-blue-600 text-white rounded px-3 py-2 hover:bg-blue-700" onClick={continueInternal}>Start Conversation</button>
          ) : (
            <button className="w-full bg-blue-600 text-white rounded px-3 py-2 hover:bg-blue-700" onClick={continuePlugin}>Continue to Plugin Configuration</button>
          )}
        </div>
      </div>
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
