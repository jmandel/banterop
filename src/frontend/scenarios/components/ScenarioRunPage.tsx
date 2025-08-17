import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { Card, CardHeader, Button } from '../../ui';
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
  const [runMode, setRunMode] = useState<'internal'|'mcp'|'a2a'>(() => {
    try {
      const params = new URLSearchParams(location.hash.split('?')[1] || '');
      const mode = params.get('mode');
      if (mode === 'plugin' || mode === 'mcp') return 'mcp';
      if (mode === 'a2a') return 'a2a';
      const lt = localStorage.getItem('scenarioLauncher.launchType');
      return (lt === 'mcp' || lt === 'plugin') ? 'mcp' : 'internal';
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
          const modeLabel = runMode === 'internal' ? 'Internal' : (runMode === 'mcp' ? 'External MCP Client' : 'External A2A Client');
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
    const modeLabel = runMode === 'internal' ? 'Internal' : (runMode === 'mcp' ? 'External MCP Client' : 'External A2A Client');
    setTitle(base ? `${base} - ${modeLabel}` : (runMode === 'internal' ? 'Internal Run' : (runMode === 'mcp' ? 'MCP Client Run' : 'A2A Client Run')));
  }, [runMode, scenario]);

  const agentOptions = useMemo(() => (scenario?.config?.agents || []).map((a: any) => a.agentId), [scenario]);

  useEffect(() => {
    try { localStorage.setItem('scenarioLauncher.launchType', runMode === 'mcp' ? 'mcp' : 'watch'); } catch {}
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
    const config64 = encodeBase64Url(meta); // MCP bridge expects ConversationMeta directly
    navigate(`/scenarios/${encodeURIComponent(scenarioId!)}/external-mcp-client/${config64}`);
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
        <div className="grid grid-cols-3 gap-3">
          <div className={`p-3 border-2 rounded cursor-pointer ${runMode==='internal'?'border-blue-600 bg-blue-50':'border-gray-200 hover:border-gray-300'}`} onClick={() => setRunMode('internal')}>
            <div className="font-medium">Internal (Simulated)</div>
            <div className="text-xs text-slate-600">Run with internal agents</div>
          </div>
          <div className={`p-3 border-2 rounded cursor-pointer ${runMode==='mcp'?'border-blue-600 bg-blue-50':'border-gray-200 hover:border-gray-300'}`} onClick={() => setRunMode('mcp')}>
            <div className="font-medium">External (MCP Client)</div>
            <div className="text-xs text-slate-600">Connect an external MCP client</div>
          </div>
          <div className={`p-3 border-2 rounded cursor-pointer ${runMode==='a2a'?'border-blue-600 bg-blue-50':'border-gray-200 hover:border-gray-300'}`} onClick={() => setRunMode('a2a')}>
            <div className="font-medium">External (A2A Client)</div>
            <div className="text-xs text-slate-600">Connect an external A2A client</div>
          </div>
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Conversation Title</label>
          <input className="w-full border border-[color:var(--border)] rounded-2xl px-3 py-2 bg-[color:var(--panel)] text-[color:var(--text)]" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">Description (optional)</label>
          <textarea className="w-full border border-[color:var(--border)] rounded-2xl px-3 py-2 bg-[color:var(--panel)] text-[color:var(--text)]" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </div>

        <div>
          <label className="block text-sm text-slate-700 mb-1">{runMode !== 'internal' ? (runMode === 'mcp' ? 'External Client Agent (MCP)' : 'External Client Agent (A2A)') : 'Starting Agent'}</label>
          <select className="w-full border border-[color:var(--border)] rounded-2xl px-3 py-2 bg-[color:var(--panel)] text-[color:var(--text)]" value={startingAgentId} onChange={(e) => setStartingAgentId(e.target.value)}>
            {agentOptions.map((id: string) => (<option key={id} value={id}>{id}</option>))}
          </select>
        </div>

        {/* Agent model configuration (from Scenario Launcher) */}
        {modelOptions.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-medium">Agent Configuration</div>
            <div className="space-y-4">
              {(scenario?.config?.agents || []).filter((a: any) => !((runMode !== 'internal') && a.agentId === startingAgentId)).map((a: any) => (
                <Card key={a.agentId} className="space-y-2">
                  <div className="text-sm font-medium text-slate-700 break-all">{a.agentId}</div>
                  <div className="grid grid-cols-3 items-center gap-2">
                    <div className="col-span-1 text-xs text-slate-600">Model</div>
                    <div className="col-span-2">
                      <select
                        className="w-full border border-[color:var(--border)] rounded-2xl px-2 py-1 text-sm bg-[color:var(--panel)] text-[color:var(--text)]"
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
                        className="w-full border border-[color:var(--border)] rounded-2xl px-2 py-1 text-xs bg-[color:var(--panel)] text-[color:var(--text)]"
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
                        className="w-full border border-[color:var(--border)] rounded-2xl px-2 py-1 text-xs bg-[color:var(--panel)] text-[color:var(--text)]"
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
          ) : runMode === 'mcp' ? (
            <Button variant="primary" className="w-full" onClick={continuePlugin}>Continue to MCP Configuration</Button>
          ) : (
            <Button variant="primary" className="w-full" onClick={() => {
              const meta = buildMeta();
              const config64 = encodeBase64Url(meta);
              navigate(`/scenarios/${encodeURIComponent(scenarioId!)}/external-a2a-client/${config64}`);
            }}>Continue to A2A Configuration</Button>
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
