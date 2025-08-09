import React, { useEffect, useState, useCallback } from "react";
import { HashRouter as Router, Routes, Route, useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";

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
    llmProvider: string;
    model: string;
  }>;
  startingAgentId: string;
}

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
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedScenario, setSelectedScenario] = useState<ScenarioItem | null>(null);
  const [launchConfig, setLaunchConfig] = useState<LaunchConfig | null>(null);
  const [launching, setLaunching] = useState(false);

  const loadScenarios = async () => {
    try {
      setLoading(true);
      const result = await wsRpcCall<ScenarioItem[]>("listScenarios", {});
      setScenarios(result);
    } catch (err) {
      console.error("Failed to load scenarios:", err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadScenarios();
  }, []);

  const handleSelectScenario = (scenario: ScenarioItem) => {
    setSelectedScenario(scenario);
    
    // Extract agent configurations from scenario
    const agents = scenario.config?.agents?.map((a: any) => ({
      id: a.agentId,
      displayName: a.agentId.replace(/-/g, ' ').replace(/\b\w/g, (c: string) => c.toUpperCase()),
      llmProvider: 'browserside',
      model: 'gemini-2.5-flash'
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
      
      // Create conversation with scenario
      const result = await wsRpcCall<{ conversationId: number }>("createConversation", {
        meta: {
          title: launchConfig.title,
          scenarioId: launchConfig.scenarioId,
          agents: launchConfig.agents.map(a => ({
            id: a.id,
            displayName: a.displayName,
            config: {
              llmProvider: a.llmProvider,
              model: a.model
            }
          })),
          startingAgentId: launchConfig.startingAgentId
        }
      });
      
      // Navigate to conversation view
      navigate(`/conversation/${result.conversationId}`);
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
        {selectedScenario && launchConfig && (
          <div className="space-y-4">
            <h2 className="text-lg font-semibold">Launch Configuration</h2>
            
            <div className="p-4 border border-gray-200 rounded-lg space-y-4">
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

              {/* Starting Agent */}
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Starting Agent
                </label>
                <select
                  value={launchConfig.startingAgentId}
                  onChange={(e) => setLaunchConfig({ ...launchConfig, startingAgentId: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md"
                >
                  {launchConfig.agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {agent.displayName}
                    </option>
                  ))}
                </select>
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
                        <div>
                          <label className="block text-xs text-gray-500">Provider</label>
                          <select
                            value={agent.llmProvider}
                            onChange={(e) => {
                              const newAgents = [...launchConfig.agents];
                              newAgents[idx] = { ...agent, llmProvider: e.target.value };
                              setLaunchConfig({ ...launchConfig, agents: newAgents });
                            }}
                            className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                          >
                            <option value="browserside">Browserside</option>
                            <option value="google">Google</option>
                            <option value="openrouter">OpenRouter</option>
                            <option value="mock">Mock</option>
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500">Model</label>
                          <select
                            value={agent.model}
                            onChange={(e) => {
                              const newAgents = [...launchConfig.agents];
                              newAgents[idx] = { ...agent, model: e.target.value };
                              setLaunchConfig({ ...launchConfig, agents: newAgents });
                            }}
                            className="w-full px-2 py-1 text-sm border border-gray-300 rounded"
                          >
                            <option value="gemini-2.5-flash">Gemini 2.5 Flash</option>
                            <option value="gemini-2.5-flash-lite">Gemini 2.5 Flash Lite</option>
                            <option value="gemini-2.5-pro">Gemini 2.5 Pro</option>
                            <option value="mock-model">Mock Model</option>
                          </select>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Launch Button */}
              <button
                onClick={handleLaunch}
                disabled={launching}
                className={`w-full py-2 px-4 rounded-md font-medium transition-colors ${
                  launching
                    ? "bg-gray-300 text-gray-500 cursor-not-allowed"
                    : "bg-blue-600 text-white hover:bg-blue-700"
                }`}
              >
                {launching ? "Launching..." : "Launch Scenario"}
              </button>
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
        )}
      </div>
    </div>
  );
}

function ConversationView({ id }: { id: number }) {
  const navigate = useNavigate();
  const [conversation, setConversation] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadConversation = async () => {
      try {
        setLoading(true);
        const result = await wsRpcCall<any>("getConversation", {
          conversationId: id,
          includeScenario: false
        });
        setConversation(result);
      } catch (err) {
        console.error("Failed to load conversation:", err);
      } finally {
        setLoading(false);
      }
    };
    
    loadConversation();
  }, [id]);

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
          
          <div className="p-4 border border-blue-200 bg-blue-50 rounded-lg">
            <div className="text-sm text-blue-800">
              <strong>View in Watch App:</strong> The conversation has been created and agents are running.
              Open the <a href="/watch#/conversation/{id}" className="underline hover:text-blue-900">Watch app</a> to monitor the conversation in real-time.
            </div>
          </div>
        </div>
      )}
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
          <Route path="/conversation/:id" element={
            <ConversationView id={Number(window.location.hash.split("/").pop())} />
          } />
        </Routes>
      </Router>
    </div>
  );
}

// Mount the app
import ReactDOM from "react-dom/client";
const root = ReactDOM.createRoot(document.getElementById("root")!);
root.render(<App />);