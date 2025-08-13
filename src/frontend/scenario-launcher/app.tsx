import React, { useEffect, useState, useCallback, useRef } from "react";
import { HashRouter as Router, Routes, Route, useNavigate, useParams, Link } from "react-router-dom";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import { BrowserAgentRegistry } from '$src/agents/clients/browser-agent-registry';
import { BrowserAgentHost } from '$src/agents/clients/browser-agent-host';
import { BrowserAgentLifecycleManager } from '$src/agents/clients/browser-agent-lifecycle';
import { WsControl } from '$src/control/ws.control';
import type { UnifiedEvent } from "$src/types/event.types";

dayjs.extend(relativeTime);

// Pull server URL from HTML-injected config if it exists, else default
declare const __API_BASE__: string | undefined;
const API_BASE: string =
  (typeof window !== "undefined" &&
    (window as any).__APP_CONFIG__?.API_BASE) ||
  (typeof __API_BASE__ !== "undefined" ? __API_BASE__ : "http://localhost:3000/api");

// Minimal one-shot WS JSON-RPC helper
async function wsRpcCall<T>(method: string, params?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const wsUrl = API_BASE.startsWith("http")
      ? API_BASE.replace(/^http/, "ws") + "/ws"
      : `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${API_BASE}/ws`;

    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID();

    ws.onopen = () => {
      ws.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    };

    ws.onmessage = (evt) => {
      const msg = JSON.parse(evt.data as string);
      if (msg.id !== id) return;
      ws.close();
      if (msg.error) {
        reject(new Error(msg.error.message));
      } else {
        resolve(msg.result as T);
      }
    };

    ws.onerror = (err) => reject(err);
  });
}

interface ScenarioItem {
  id: string;
  name: string;
  config: any;
  createdAt: string;
  modifiedAt: string;
}

interface LaunchConfig {
  scenarioId: string;
  title: string;
  agents: Array<{
    id: string;
    displayName: string;
    model: string;
  }>;
  startingAgentId: string;
}

type LaunchType = 'watch' | 'plugin';

function useHealthPing(intervalMs = 8000) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    let timer: any;
    const tick = async () => {
      try {
        await wsRpcCall("ping");
        if (!cancelled) setOk(true);
      } catch {
        if (!cancelled) setOk(false);
      } finally {
        if (!cancelled) timer = setTimeout(tick, intervalMs);
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [intervalMs]);
  return ok;
}

function ScenarioList() {
  const navigate = useNavigate();
  const params = useParams<{ scenarioId?: string }>();
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedScenario, setSelectedScenario] = useState<ScenarioItem | null>(null);
  const [launchConfig, setLaunchConfig] = useState<LaunchConfig | null>(null);
  const [launching, setLaunching] = useState(false);
  const [availableModels, setAvailableModels] = useState<string[]>([]);
  const [runMode, setRunMode] = useState<'client'|'server'>(() => {
    try { return (localStorage.getItem('scenarioLauncher.runMode') as 'client'|'server') || 'client'; } catch { return 'client'; }
  });
  const [launchType, setLaunchType] = useState<LaunchType>(() => {
    try { return (localStorage.getItem('scenarioLauncher.launchType') as LaunchType) || 'watch'; } catch { return 'watch'; }
  });
  const serverControlRef = useRef<WsControl | null>(null);

  const loadScenarios = async () => {
    try {
      setLoading(true);
      const url = API_BASE.startsWith('http')
        ? `${API_BASE}/scenarios`
        : `${location.protocol}//${location.host}${API_BASE}/scenarios`;
      const res = await fetch(url);
      const list = res.ok ? await res.json() : [];
      setScenarios(list || []);
    } catch (err) {
      console.error("Failed to load scenarios:", err);
    } finally {
      setLoading(false);
    }
  };

  // Client-side lifecycle manager is used in ConversationView

  const loadAvailableModels = async () => {
    try {
      // Construct the correct URL - API_BASE already includes /api
      const url = API_BASE.startsWith('http') 
        ? `${API_BASE}/llm/providers`
        : `${location.protocol}//${location.host}${API_BASE}/llm/providers`;
      
      console.log('Fetching models from:', url);
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Failed to fetch providers: ${response.statusText}`);
      }
      
      const providers = await response.json();
      console.log('Received providers:', providers);
      
      // Extract all model names from all providers (except browserside)
      const models = new Set<string>();
      for (const provider of providers) {
        // Skip browserside provider since it's just a proxy
        if (provider.name === 'browserside') {
          continue;
        }
        
        if (provider.models && Array.isArray(provider.models)) {
          // Models are directly strings in the array
          for (const model of provider.models) {
            models.add(model);
          }
        }
      }
      
      const sortedModels = Array.from(models).sort();
      console.log('Available models from server:', sortedModels);
      setAvailableModels(sortedModels);
    } catch (err) {
      console.error("Failed to load available models:", err);
      // No fallback - if we can't get models from server, we have no models
      setAvailableModels([]);
    }
  };

  useEffect(() => {
    loadScenarios();
    loadAvailableModels();
  }, []);

  // Handle URL-based scenario selection
  useEffect(() => {
    if (params.scenarioId && scenarios.length > 0) {
      const scenario = scenarios.find(s => s.id === params.scenarioId);
      if (scenario && scenario.id !== selectedScenario?.id) {
        // Don't update URL when selecting from URL
        setSelectedScenario(scenario);
        
        // Use the first available model, or empty string if none available yet
        const defaultModel = availableModels.length > 0 ? availableModels[0] : '';
        
        // Extract agent configurations from scenario
        const agents = scenario.config?.agents?.map((a: any) => ({
          id: a.agentId,
          displayName: a.agentId.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
          model: defaultModel
        })) || [];

        setLaunchConfig({
          scenarioId: scenario.id,
          title: `${scenario.name} - ${new Date().toLocaleString()}`,
          agents,
          startingAgentId: agents[0]?.id || ''
        });
      }
    }
  }, [params.scenarioId, scenarios, availableModels]);

  // Update launch config when models become available
  useEffect(() => {
    if (launchConfig && availableModels.length > 0) {
      // If any agent has no model selected, update it to the first available
      const needsUpdate = launchConfig.agents.some(a => !a.model);
      if (needsUpdate) {
        setLaunchConfig(prev => {
          if (!prev) return prev;
          return {
            ...prev,
            agents: prev.agents.map(agent => ({
              ...agent,
              model: agent.model || availableModels[0] || ''
            }))
          };
        });
      }
    }
  }, [availableModels]);


  const handleSelectScenario = (scenario: ScenarioItem) => {
    setSelectedScenario(scenario);
    
    // Update URL to reflect selected scenario
    if (scenario.id !== params.scenarioId) {
      navigate(`/scenario/${scenario.id}`);
    }
    
    // Use the first available model, or empty string if none available yet
    const defaultModel = availableModels.length > 0 ? availableModels[0] : '';
    
    // Extract agent configurations from scenario
    const agents = scenario.config?.agents?.map((a: any) => ({
      id: a.agentId,
      displayName: a.agentId.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      model: defaultModel
    })) || [];

    setLaunchConfig({
      scenarioId: scenario.id,
      title: `${scenario.name} - ${new Date().toLocaleString()}`,
      agents,
      startingAgentId: agents[0]?.id || ''
    });
  };

  const handleLaunch = async () => {
    if (!launchConfig) return;
    
    try {
      setLaunching(true);
      if (launchType === 'plugin') {
        // Build bridge meta template and navigate to pre-launch page
        const config64 = await buildBridgeConfig64(launchConfig);
        try { localStorage.setItem('scenarioLauncher.launchType', launchType); } catch {}
        navigate(`/plugin/${config64}`);
        return;
      }
      
      // Create conversation with scenario - exactly like CLI demo
      console.log('Creating conversation with startingAgentId:', launchConfig.startingAgentId);
      const result = await wsRpcCall<{ conversationId: number }>("createConversation", {
        meta: {
          title: launchConfig.title,
          scenarioId: launchConfig.scenarioId,
          agents: launchConfig.agents.map(a => ({
            id: a.id,
            displayName: a.displayName,
            config: { model: a.model }
          })),
          startingAgentId: launchConfig.startingAgentId,
          custom: {
            autoRun: false  // Don't auto-run server-side, we're running browserside
          }
        }
      });
      console.log('Created conversation:', result);
      
      // Navigate to conversation view with auto-start flag and selected mode
      try { localStorage.setItem('scenarioLauncher.runMode', runMode); } catch {}
      navigate(`/conversation/${result.conversationId}?autostart=true&mode=${runMode}`);
    } catch (err) {
      console.error("Failed to launch scenario:", err);
      alert(`Failed to launch: ${err}`);
    } finally {
      setLaunching(false);
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">Loading scenarios...</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">Scenario Launcher</h1>
      
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Scenario List */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Available Scenarios</h2>
          <div className="space-y-2">
            {scenarios.map((scenario) => (
              <div
                key={scenario.id}
                onClick={() => handleSelectScenario(scenario)}
                className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                  selectedScenario?.id === scenario.id
                    ? "border-blue-500 bg-blue-50"
                    : "border-gray-200 hover:border-gray-300 hover:bg-gray-50"
                }`}
              >
                <div className="font-semibold">{scenario.name}</div>
                <div className="text-sm text-gray-600">{scenario.id}</div>
                {scenario.config?.metadata?.description && (
                  <div className="text-sm text-gray-500 mt-1">
                    {scenario.config.metadata.description}
                  </div>
                )}
                {scenario.config?.metadata?.tags && (
                  <div className="flex gap-1 mt-2">
                    {scenario.config.metadata.tags.map((tag: string) => (
                      <span
                        key={tag}
                        className="text-xs bg-gray-100 text-gray-600 px-2 py-1 rounded"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Launch Configuration */}
        {selectedScenario && launchConfig && (<>
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Launch Configuration</h2>
            
            <div className="p-4 border border-gray-200 rounded-lg space-y-4">
              {/* Launch Type */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Choose an action</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => { setLaunchType('watch'); try { localStorage.setItem('scenarioLauncher.launchType', 'watch'); } catch {} }}
                    className={`px-3 py-2 rounded border ${launchType === 'watch' ? 'bg-blue-600 text-white border-blue-700' : 'bg-white hover:bg-gray-50'}`}
                  >
                    Watch Simulated Conversation
                  </button>
                  <button
                    type="button"
                    onClick={() => { setLaunchType('plugin'); try { localStorage.setItem('scenarioLauncher.launchType', 'plugin'); } catch {} }}
                    className={`px-3 py-2 rounded border ${launchType === 'plugin' ? 'bg-purple-600 text-white border-purple-700' : 'bg-white hover:bg-gray-50'}`}
                  >
                    Plug Into Simulated Conversation
                  </button>
                </div>
                <p className="text-xs text-gray-500 mt-2">
                  {launchType === 'plugin'
                    ? 'Generate an MCP URL and connect your MCP client as the selected role.'
                    : 'Create a new conversation and watch it here; agents can run in browser or on server.'}
                </p>
              </div>
              {/* Run Mode (watch only) */}
              {launchType === 'watch' && (
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1">Run Mode</label>
                  <select
                    value={runMode}
                    onChange={(e) => setRunMode(e.target.value as 'client'|'server')}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md"
                  >
                    <option value="client">Run agents in browser (client-managed)</option>
                    <option value="server">Run agents on server (server-managed)</option>
                  </select>
                </div>
              )}

              {/* Title */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Conversation Title
                </label>
                <input
                  type="text"
                  value={launchConfig.title}
                  onChange={(e) => setLaunchConfig({ ...launchConfig, title: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                />
              </div>

              {/* Starting / Plug-in Agent */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {launchType === 'plugin' ? 'External Agent (MCP client)' : 'Starting Agent'}
                </label>
                <div className="space-y-1">
                  {launchConfig.agents.map((agent) => (
                    <label key={agent.id} className="flex items-center gap-2 text-sm">
                      <input
                        type="radio"
                        name="startingAgentId"
                        value={agent.id}
                        checked={launchConfig.startingAgentId === agent.id}
                        onChange={() => setLaunchConfig({ ...launchConfig, startingAgentId: agent.id })}
                      />
                      <span>{agent.displayName}</span>
                      <span className="text-xs text-gray-500">({agent.id})</span>
                    </label>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-1">
                  {launchType === 'plugin'
                    ? 'Your MCP client will speak as this agent id.'
                    : 'This agent sends the first message in the simulation.'}
                </p>
              </div>

              {/* Agent Configurations */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Agent Configurations
                </label>
                <div className="space-y-2">
                  {launchConfig.agents.map((agent, idx) => (
                    <div key={agent.id} className="p-3 bg-gray-50 rounded-md">
                      <div className="font-medium text-sm mb-2">{agent.displayName}</div>
                      <div className="grid grid-cols-2 gap-2">
                        <div className="col-span-2">
                          <label className="block text-xs text-gray-500">Model (hint)</label>
                          <select
                            value={agent.model}
                            onChange={(e) => {
                              const newAgents = [...launchConfig.agents];
                              newAgents[idx] = { ...agent, model: e.target.value };
                              setLaunchConfig({ ...launchConfig, agents: newAgents });
                            }}
                            className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                            disabled={availableModels.length === 0}
                          >
                            {availableModels.length > 0 ? (
                              availableModels.map((model) => (
                                <option key={model} value={model}>
                                  {model}
                                </option>
                              ))
                            ) : (
                              <option value="">No models available</option>
                            )}
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Primary Action */}
              {launchType === 'watch' ? (
                <button
                  onClick={handleLaunch}
                  disabled={launching}
                  className={`w-full py-2 px-4 rounded-md font-medium transition-colors ${
                    launching ? "bg-gray-300 text-gray-500 cursor-not-allowed" : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                >
                  {launching ? 'Launching…' : 'Launch Scenario'}
                </button>
              ) : (
                <button
                  onClick={handleLaunch}
                  disabled={launching}
                  className={`w-full py-2 px-4 rounded-md font-medium transition-colors ${
                    launching ? "bg-gray-300 text-gray-500 cursor-not-allowed" : "bg-purple-600 text-white hover:bg-purple-700"
                  }`}
                >
                  {launching ? 'Preparing…' : 'Open MCP Pre‑Launch'}
                </button>
              )}
            </div>

            {/* Scenario Details */}
            <div className="p-4 border border-gray-200 rounded-lg">
              <h3 className="font-semibold mb-2">Scenario Details</h3>
              <div className="space-y-2 text-sm">
                {selectedScenario.config?.scenario?.background && (
                  <div>
                    <span className="font-medium">Background:</span>
                    <div className="text-gray-600 mt-1">
                      {selectedScenario.config.scenario.background}
                    </div>
                  </div>
                )}
                {selectedScenario.config?.scenario?.challenges && (
                  <div>
                    <span className="font-medium">Challenges:</span>
                    <ul className="list-disc list-inside text-gray-600 mt-1">
                      {selectedScenario.config.scenario.challenges.map((c: string, i: number) => (
                        <li key={i}>{c}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* No inline Plug-In panel: use dedicated pre-launch screen */}
        </>)}
      </div>
    </div>
  );
}

function ConversationViewWrapper() {
  const params = useParams<{ id: string }>();
  const id = params.id ? Number(params.id) : 0;
  console.log('ConversationViewWrapper - params:', params, 'id:', id);
  return <ConversationView id={id} />;
}

function ConversationView({ id }: { id: number }) {
  const navigate = useNavigate();
  const [conversation, setConversation] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [agentsRunning, setAgentsRunning] = useState(false);
  const [messages, setMessages] = useState<UnifiedEvent[]>([]);
  const [starting, setStarting] = useState(false);
  const startingRef = useRef(false);
  const managerRef = useRef<BrowserAgentLifecycleManager | null>(null);
  const serverControlRef = useRef<WsControl | null>(null);
  const eventWsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const programmaticScrollRef = useRef(false);
  const [autoScroll, setAutoScroll] = useState(true);
  
  // Check if we should auto-start agents
  const urlParams = new URLSearchParams(window.location.search);
  const shouldAutoStart = urlParams.get('autostart') === 'true';
  const runModeParam = urlParams.get('mode') as ('client'|'server') | null;
  const runMode: 'client'|'server' = runModeParam || (localStorage.getItem('scenarioLauncher.runMode') as any) || 'client';

  // Subscribe to events (separate from agent lifecycle)
  const subscribeToEvents = () => {
    if (eventWsRef.current) return; // Already subscribed
    
    const wsUrl = API_BASE.startsWith('http')
      ? API_BASE.replace(/^http/, 'ws') + '/ws'
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API_BASE}/ws`;
    
    const eventWs = new WebSocket(wsUrl);
    eventWsRef.current = eventWs;
    
    eventWs.addEventListener('open', () => {
      // Subscribe and also get all events since the beginning
      eventWs.send(JSON.stringify({
        jsonrpc: '2.0',
        method: 'subscribe',
        params: { conversationId: id, sinceSeq: 0 },
        id: 'sub-1'
      }));
    });
    
    eventWs.addEventListener('message', (event) => {
      try {
        const msg = JSON.parse(event.data);
        
        // Skip RPC responses (they have an id field for the request)
        if (msg.id === 'sub-1') {
          console.log('Subscription confirmed:', msg);
          return;
        }
        
        // Handle both RPC notification format and direct event format
        let evt: UnifiedEvent | null = null;
        
        if (msg.method === 'event' && msg.params) {
          // RPC notification format: { method: 'event', params: {...} }
          evt = msg.params as UnifiedEvent;
          console.log('Received event (RPC format):', evt?.type, evt);
        } else if (msg.type && msg.conversation === id) {
          // Direct event format: { type: 'message', conversation: 5, ... }
          evt = msg as UnifiedEvent;
          console.log('Received event (direct format):', evt?.type, evt);
        } else {
          console.log('Unknown message format:', msg);
        }
        
        if (evt && evt.type === 'message') {
          console.log('Processing message event:', evt);
          setMessages(prev => {
            // Check if we already have this message (by seq)
            const exists = prev.some(m => m.seq === evt.seq);
            if (exists) {
              console.log('Message already exists, skipping:', evt.seq);
              return prev;
            }
            console.log('Adding new message:', evt.seq);
            return [...prev, evt].sort((a, b) => a.seq - b.seq);
          });
        } else if (evt) {
          console.log('Skipping non-message event:', evt.type);
        }
      } catch (e) {
        console.error('Failed to parse event:', e);
      }
    });
    
    eventWs.addEventListener('close', () => {
      eventWsRef.current = null;
    });
  };

  // start/stop helpers are implemented by startAgentsManaged/stopAgentsManaged
  const startAgentsManaged = async () => {
    if (!conversation || agentsRunning || startingRef.current) return;
    startingRef.current = true;
    setStarting(true);
    try {
      const wsUrl = API_BASE.startsWith('http')
        ? API_BASE.replace(/^http/, 'ws') + '/ws'
        : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API_BASE}/ws`;
      if (!managerRef.current) {
        const reg = new BrowserAgentRegistry();
        const host = new BrowserAgentHost(wsUrl);
        managerRef.current = new BrowserAgentLifecycleManager(reg, host);
      }
      const agentIds = conversation.metadata?.agents?.map((a: any) => a.id) || [];
      await managerRef.current.ensure(id, agentIds);
      setAgentsRunning(true);
    } catch (err) {
      console.error('Failed to start agents:', err);
      setAgentsRunning(false);
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
  };

  const stopAgentsManaged = async () => {
    try {
      if (managerRef.current) await managerRef.current.stop(id);
    } finally {
      setAgentsRunning(false);
    }
  };
  
  useEffect(() => {
    // Stop any running agents when conversation changes (client manager)
    stopAgentsManaged();
    
    // Close existing event subscription when conversation changes
    if (eventWsRef.current) {
      eventWsRef.current.close();
      eventWsRef.current = null;
    }
    
    // Clear messages when switching conversations
    setMessages([]);
    
    const loadConversation = async () => {
      try {
        setLoading(true);
        const result = await wsRpcCall<any>("getConversation", {
          conversationId: id,
          includeScenario: false
        });
        setConversation(result);
        
        // Load existing events from the conversation
        if (result.events && Array.isArray(result.events)) {
          const messageEvents = result.events.filter((e: UnifiedEvent) => e.type === 'message');
          console.log('Loaded existing messages:', messageEvents.length);
          setMessages(messageEvents);
        }
        
        // Subscribe to events immediately (for new messages)
        subscribeToEvents();
        
        // Auto-start agents (client or server) if requested
        if (shouldAutoStart && !agentsRunning) {
          window.history.replaceState(null, '', `#/conversation/${id}`);
          if (runMode === 'client') {
            startAgentsManaged();
          } else {
            // server-managed ensure
            try {
              setStarting(true);
              const agentIds = (result.metadata?.agents || []).map((a: any) => a.id);
              if (!serverControlRef.current) serverControlRef.current = new WsControl(API_BASE.replace(/^http/, 'ws') + '/ws');
              await serverControlRef.current.ensureAgentsRunningOnServer(id as unknown as number, agentIds);
              setAgentsRunning(true);
            } catch (e) {
              console.error('Failed to ensure server agents:', e);
            } finally { setStarting(false); }
          }
        }
      } catch (err) {
        console.error("Failed to load conversation:", err);
      } finally {
        setLoading(false);
      }
    };
    
    loadConversation();
    
    // Cleanup on unmount
    return () => {
      stopAgentsManaged();
      if (eventWsRef.current) {
        eventWsRef.current.close();
        eventWsRef.current = null;
      }
    };
  }, [id]);
  
  // Warn before leaving if agents are running
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (agentsRunning) {
        e.preventDefault();
        e.returnValue = 'Agents are still running. Are you sure you want to leave?';
      }
    };
    
    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [agentsRunning]);

  // Auto-scroll to bottom on new messages when enabled (instant for snappy UX)
  useEffect(() => {
    if (!autoScroll) return;
    const el = scrollRef.current;
    if (!el) return;
    try {
      programmaticScrollRef.current = true;
      el.scrollTo({ top: el.scrollHeight, behavior: 'auto' });
    } finally {
      // Clear the programmatic flag on next tick to avoid swallowing real scrolls
      setTimeout(() => { programmaticScrollRef.current = false; }, 0);
    }
  }, [messages, autoScroll]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="text-gray-500">Loading conversation...</div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-2xl font-bold">Conversation #{id}</h1>
        <button
          onClick={() => navigate("/")}
          className="px-4 py-2 text-sm border border-gray-300 rounded-md hover:bg-gray-50"
        >
          Back to Launcher
        </button>
      </div>
      
      {conversation && (
        <div className="space-y-4">
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="font-medium">Title:</span> {conversation.metadata?.title || "Untitled"}
              </div>
              <div>
                <span className="font-medium">Status:</span> {conversation.status}
              </div>
              <div>
                <span className="font-medium">Scenario:</span> {conversation.metadata?.scenarioId || "None"}
              </div>
              <div>
                <span className="font-medium">Created:</span> {dayjs(conversation.createdAt).format("YYYY-MM-DD HH:mm:ss")}
              </div>
            </div>
          </div>
          
          <div className="space-y-4">
            {!agentsRunning ? (
              <div className="p-4 border border-blue-200 bg-blue-50 rounded-lg">
                <div className="text-sm text-blue-800 mb-3">
                  <strong>Agents not running.</strong> Start agents to continue the conversation. Mode: <em>{runMode}</em>
                </div>
                <button
                  onClick={async () => {
                    if (starting || agentsRunning) return;
                    setStarting(true);
                    if (runMode === 'client') {
                      try {
                        await startAgentsManaged();
                      } finally {
                        // startAgents sets agentsRunning appropriately
                        setStarting(false);
                      }
                    } else {
                      // Ensure agents on the server
                      try {
                        const agentIds = (conversation?.metadata?.agents || []).map((a: any) => a.id);
                        // Optimistically mark as running to reflect intent immediately
                        setAgentsRunning(true);
                        if (!serverControlRef.current) serverControlRef.current = new WsControl(API_BASE.replace(/^http/, 'ws') + '/ws');
                        await serverControlRef.current.ensureAgentsRunningOnServer(id as unknown as number, agentIds);
                      } catch (e) {
                        console.error('Failed to ensure server agents:', e);
                        setAgentsRunning(false);
                        alert(`Failed to ensure server agents: ${e}`);
                      } finally {
                        setStarting(false);
                      }
                    }
                  }}
                  disabled={starting || agentsRunning}
                  className={`px-4 py-2 rounded-md transition-colors ${starting || agentsRunning ? 'bg-gray-300 text-gray-500 cursor-not-allowed' : 'bg-blue-600 text-white hover:bg-blue-700'}`}
                >
                  {starting ? 'Starting…' : (runMode === 'client' ? 'Start Agents (Browser)' : 'Ensure Agents (Server)')}
                </button>
              </div>
            ) : (
              <div className="p-4 border border-green-200 bg-green-50 rounded-lg">
                <div className="text-sm text-green-800 flex items-center justify-between">
                  <div>
                    <strong>Agents are running!</strong> The conversation is in progress. Mode: <em>{runMode}</em>
                  </div>
                  <button
                    onClick={stopAgentsManaged}
                    className="px-3 py-1 bg-red-600 text-white rounded text-xs hover:bg-red-700"
                  >
                    {runMode === 'client' ? 'Stop Agents (Browser)' : 'Stop Agents (Server)'}
                  </button>
                </div>
              </div>
            )}
            
            <div
              className="p-4 border border-gray-200 rounded-lg max-h-96 overflow-y-auto"
              ref={scrollRef}
              onScroll={() => {
                const el = scrollRef.current;
                if (!el) return;
                if (programmaticScrollRef.current) return;
                const atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight;
                if (atBottom) setAutoScroll(true);
                else setAutoScroll(false);
              }}
            >
              <div className="text-sm font-semibold mb-2">Messages ({messages.length} total):</div>
              <div className="space-y-2">
                {messages.length === 0 ? (
                  <div className="text-gray-500 text-sm">No messages yet...</div>
                ) : (
                  messages.map((msg, idx) => (
                    <div key={`${msg.seq}-${idx}`} className="p-2 bg-gray-50 rounded text-sm">
                      <div className="flex items-center gap-2">
                        <div className="font-medium text-blue-600">[{msg.agentId}]</div>
                        <div className="text-xs text-gray-400">seq: {msg.seq}</div>
                      </div>
                      <div className="text-gray-700">{(msg.payload as any)?.text || JSON.stringify(msg.payload)}</div>
                    </div>
                  ))
                )}
              </div>
            </div>
            
            <div className="p-4 border border-yellow-200 bg-yellow-50 rounded-lg">
              <div className="text-sm text-yellow-800">
                <strong>Monitor in Watch App:</strong> For a better viewing experience,
                open the <a href={`/watch#/conversation/${id}`} className="underline hover:text-yellow-900">Watch app</a> in a new tab.
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// Utilities for Plug-In bridge
async function sha256Base64Url(input: string): Promise<string> {
  const enc = new TextEncoder();
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(input));
  const bytes = new Uint8Array(digest);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlEncodeJson(obj: any): string {
  const json = JSON.stringify(obj);
  // UTF-8 safe base64url
  const utf8 = new TextEncoder().encode(json);
  let bin = '';
  for (let i = 0; i < utf8.length; i++) bin += String.fromCharCode(utf8[i]!);
  const b64 = btoa(bin);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeJson<T = any>(b64url: string): T {
  const normalized = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  const base64 = normalized + pad;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const json = new TextDecoder().decode(bytes);
  return JSON.parse(json);
}

async function buildBridgeConfig64(cfg: LaunchConfig): Promise<string> {
  // Build a ConvConversationMeta-like payload for the bridge
  const meta = {
    title: cfg.title,
    scenarioId: cfg.scenarioId,
    agents: cfg.agents.map(a => ({ id: a.id, displayName: a.displayName, config: { model: a.model } })),
    startingAgentId: cfg.startingAgentId,
  };
  return base64UrlEncodeJson(meta);
}

function useCopy(text: string): [boolean, () => void] {
  const [ok, setOk] = useState(false);
  const onCopy = useCallback(() => {
    navigator.clipboard.writeText(text).then(() => {
      setOk(true);
      setTimeout(() => setOk(false), 1000);
    }).catch(() => {});
  }, [text]);
  return [ok, onCopy];
}

// (InlineMcpUrl and InlineMcpExamples removed: dedicated pre-launch screen handles MCP details)

function McpPreLaunch() {
  const { config64 = '' } = useParams<{ config64: string }>();
  const [hash, setHash] = useState<string>('');
  const [matches, setMatches] = useState<number[]>([]);
  const [subState, setSubState] = useState<'idle'|'connecting'|'open'|'closed'>('idle');
  const [meta, setMeta] = useState<any>(null);

  const mcpUrl = API_BASE.startsWith('http')
    ? `${API_BASE}/bridge/${config64}/mcp`
    : `${location.protocol}//${location.host}${API_BASE}/bridge/${config64}/mcp`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const h = await sha256Base64Url(config64);
      if (!cancelled) setHash(h);
      try {
        const m = base64UrlDecodeJson(config64);
        if (!cancelled) setMeta(m);
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [config64]);

  useEffect(() => {
    if (!hash) return;
    const wsUrl = API_BASE.startsWith('http')
      ? API_BASE.replace(/^http/, 'ws') + '/ws'
      : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${API_BASE}/ws`;
    const ws = new WebSocket(wsUrl);
    setSubState('connecting');
    ws.onopen = () => {
      setSubState('open');
      ws.send(JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method: 'subscribeConversations' }));
    };
    ws.onmessage = async (evt) => {
      try {
        const msg = JSON.parse(String(evt.data));
        if (msg.method === 'conversation' && msg.params?.conversationId) {
          const cid = Number(msg.params.conversationId);
          try {
            const conv = await wsRpcCall<any>('getConversation', { conversationId: cid, includeScenario: false });
            const h = conv?.metadata?.custom?.bridgeConfig64Hash;
            if (h && h === hash) {
              setMatches((prev) => prev.includes(cid) ? prev : [...prev, cid]);
            }
          } catch (e) {
            // ignore fetch errors
          }
        }
      } catch {}
    };
    ws.onclose = () => setSubState('closed');
    return () => { try { ws.close(); } catch {} };
  }, [hash]);

  // On first load (or when hash changes), fetch existing conversations and match immediately
  useEffect(() => {
    if (!hash) return;
    let cancelled = false;
    (async () => {
      try {
        const url = API_BASE.startsWith('http')
          ? `${API_BASE}/debug/conversations`
          : `${location.protocol}//${location.host}${API_BASE}/debug/conversations`;
        const res = await fetch(url);
        if (!res.ok) return;
        const list: any[] = await res.json();
        const found: number[] = [];
        for (const item of list) {
          const marker = item?.metadata?.custom?.bridgeConfig64Hash;
          if (marker && marker === hash) {
            found.push(Number(item.conversation));
          }
        }
        if (!cancelled && found.length) {
          setMatches((prev) => {
            const s = new Set(prev);
            for (const id of found) s.add(id);
            return Array.from(s);
          });
        }
      } catch {}
    })();
    return () => { cancelled = true; };
  }, [hash]);

  const [copiedUrl, copyUrl] = useCopy(mcpUrl);
  const prettyMeta = meta ? JSON.stringify(meta, null, 2) : '';

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">MCP Pre‑Launch</h1>
        <Link to="/" className="px-3 py-1 border rounded hover:bg-gray-50 text-sm">Back</Link>
      </div>

      <div className="p-4 border rounded">
        <div className="text-sm text-gray-600 mb-2">Plug‑In Settings</div>
        <div className="text-sm"><span className="text-gray-500">Scenario:</span> <span className="font-mono">{meta?.scenarioId || '(none)'}</span></div>
        <div className="text-sm"><span className="text-gray-500">Plug‑in as:</span> <span className="font-mono">{meta?.startingAgentId || '(unset)'}</span></div>
      </div>

      <div className="p-4 border rounded">
        <div className="text-sm text-gray-600 mb-2">MCP Server URL</div>
        <div className="font-mono break-all p-2 bg-gray-50 rounded border">{mcpUrl}</div>
        <div className="mt-2">
          <button onClick={copyUrl} className="px-2 py-1 text-xs border rounded hover:bg-gray-50">{copiedUrl ? 'Copied!' : 'Copy URL'}</button>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="p-4 border rounded">
          <div className="text-sm text-gray-600 mb-2">Template Hash</div>
          <div className="font-mono break-all p-2 bg-gray-50 rounded border">{hash || 'computing…'}</div>
          <div className="text-xs text-gray-500 mt-2">Discovery listens for conversations stamped with this hash.</div>
        </div>
        <div className="p-4 border rounded">
          <div className="text-sm text-gray-600 mb-2">Discovery</div>
          <div className="text-xs text-gray-500">Subscription: {subState}</div>
          {matches.length === 0 ? (
            <div className="text-sm text-gray-600 mt-2">Waiting for matching conversations…</div>
          ) : (
            <div className="mt-2 space-y-1">
              {matches.map((cid) => (
                <div key={cid} className="flex items-center gap-2 text-sm">
                  <span>Conversation #{cid}</span>
                  <Link to={`/conversation/${cid}`} className="text-blue-600 hover:underline">Open here</Link>
                  <a href={`http://localhost:3001/#/conversation/${cid}`} target="_blank" className="text-blue-600 hover:underline">Open in Watch</a>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="p-4 border rounded space-y-2">
        <div className="text-sm font-semibold">Template (decoded)</div>
        <pre className="text-xs bg-gray-50 p-2 rounded border overflow-auto">{prettyMeta}</pre>
      </div>
    </div>
  );
}

function App() {
  const health = useHealthPing();
  
  return (
    <div className="min-h-screen bg-gray-50">
      <header className="bg-white border-b px-6 py-3">
        <div className="flex items-center justify-between">
          <div className="text-xl font-semibold">Scenario Launcher</div>
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <span className={`inline-block w-2 h-2 rounded-full ${
              health ? "bg-green-500" : health === false ? "bg-red-500" : "bg-gray-400"
            }`} />
            <span>{health ? "API OK" : health === false ? "API down" : "checking"}</span>
          </div>
        </div>
      </header>
      
      <Router>
        <Routes>
          <Route path="/" element={<ScenarioList />} />
          <Route path="/scenario/:scenarioId" element={<ScenarioList />} />
          <Route path="/conversation/:id" element={<ConversationViewWrapper />} />
          <Route path="/plugin/:config64" element={<McpPreLaunch />} />
        </Routes>
      </Router>
    </div>
  );
}

// Mount the app
import ReactDOM from "react-dom/client";
const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);
