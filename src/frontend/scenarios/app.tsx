import React from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter as Router, Routes, Route, Navigate, Link } from 'react-router-dom';
import { AppLayout as SharedAppLayout } from '../ui';
import { AppLayout } from './components/AppLayout';
import { Button, Card, CardHeader } from '../ui';
import { ScenarioLandingPage } from './components/ScenarioLandingPage';
import { ScenarioBuilderPage } from './components/ScenarioBuilderPage.v2';
import { ScenarioRunPage } from './components/ScenarioRunPage';
import { ScenarioPluginPage } from './components/ScenarioPluginPage';
import { ScenarioA2APreLaunchPage } from './components/ScenarioA2APreLaunchPage';
import { ScenarioConfiguredPage } from './components/ScenarioConfiguredPage';

declare const __API_BASE__: string | undefined;
const API_BASE: string =
  (typeof window !== 'undefined' && (window as any).__APP_CONFIG__?.API_BASE) ||
  (typeof __API_BASE__ !== 'undefined' ? __API_BASE__ : 'http://localhost:3000/api');

async function wsRpcCall<T>(method: string, params?: any): Promise<T> {
  return new Promise((resolve, reject) => {
    const wsUrl = API_BASE.replace(/^http/, 'ws') + '/ws';
    const ws = new WebSocket(wsUrl);
    const id = crypto.randomUUID();
    ws.onopen = () => ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
    ws.onmessage = (evt) => {
      const msg = JSON.parse(String(evt.data));
      if (msg.id !== id) return;
      ws.close();
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result as T);
    };
    ws.onerror = (e) => reject(e);
  });
}

async function http<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${API_BASE}${path.startsWith('/') ? path : `/${path}`}`;
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.json();
}

type ScenarioItem = { id: string; name: string; config: any; history: any[]; createdAt: string; modifiedAt: string };

function Layout({ children }: { children: React.ReactNode }) {
  return (
    <SharedAppLayout
      title="Scenario Builder"
      right={(
        <nav className="flex items-center gap-3">
          <Link to="/scenarios">Scenarios</Link>
          <Link to="/scenarios/create">Create</Link>
        </nav>
      )}
    >
      {children}
    </SharedAppLayout>
  );
}

function LandingPage() {
  const [scenarios, setScenarios] = useState<ScenarioItem[]>([]);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();
  useEffect(() => {
    (async () => {
      try {
        const list = await http<ScenarioItem[]>('/scenarios');
        setScenarios(list);
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  return (
    <Layout>
      <div className="flex items-center justify-between mb-3">
        <div className="font-semibold">Available Scenarios</div>
        <Button variant="primary" onClick={() => navigate('/scenarios/create')}>New Scenario</Button>
      </div>
      {loading ? (
        <div className="text-xs text-[color:var(--muted)]">Loading…</div>
      ) : (
        <div className="flex flex-wrap gap-3">
          {scenarios.map(sc => (
            <Card key={sc.id} style={{ width: 360 }}>
              <div className="font-semibold">{sc.name}</div>
              <div className="text-xs text-[color:var(--muted)] mt-1 mb-2">{sc.id}</div>
              <div className="flex items-center gap-2">
                <Button variant="secondary" onClick={() => navigate(`/scenarios/${encodeURIComponent(sc.id)}`)}>Edit</Button>
                <Button variant="secondary" onClick={() => navigate(`/scenarios/${encodeURIComponent(sc.id)}/run`)}>Run</Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </Layout>
  );
}

function BuilderPage() {
  const params = useParams<{ scenarioId?: string }>();
  const [name, setName] = useState('');
  const [json, setJson] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  const isCreate = !params.scenarioId;

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        if (!isCreate && params.scenarioId) {
          const s = await http<ScenarioItem>(`/scenarios/${encodeURIComponent(params.scenarioId)}`);
          setName(s.name);
          setJson(JSON.stringify(s.config, null, 2));
        } else {
          setName('New Scenario');
          setJson(JSON.stringify({ metadata: { id: 'my-scenario', title: 'New Scenario', background: '', challenges: [] }, agents: [] }, null, 2));
        }
      } catch (e) {
        setStatus(`Error: ${(e as Error).message}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [params.scenarioId]);

  const save = async () => {
    try {
      setStatus('Saving…');
      const config = JSON.parse(json);
      if (isCreate) {
        const res = await http<{ id: string }>(`/scenarios`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, config, history: [] }) });
        navigate(`/scenarios/${encodeURIComponent(res.id)}`);
      } else {
        await http(`/scenarios/${encodeURIComponent(params.scenarioId!)}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, config }) });
        setStatus('Saved');
        setTimeout(() => setStatus(null), 1200);
      }
    } catch (e) {
      setStatus(`Error: ${(e as Error).message}`);
    }
  };

  // Pre-config wizard: build base64 URL for a quick run
  const config64 = useMemo(() => {
    try {
      const cfg = JSON.parse(json);
      const agents = (cfg.agents || []).map((a: any) => ({ id: a.agentId || a.id, displayName: (a.agentId || a.id), config: { model: '' } }));
      const startingAgentId = agents[0]?.id || '';
      const payload = { meta: { title: name || cfg?.metadata?.title || 'Untitled', scenarioId: cfg?.metadata?.id || params.scenarioId, agents, startingAgentId } };
      const enc = btoa(JSON.stringify(payload)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      return enc;
    } catch { return ''; }
  }, [json, name, params.scenarioId]);

  return (
    <Layout>
      {loading ? (<div className="text-xs text-[color:var(--muted)]">Loading…</div>) : (
        <div className="flex items-start gap-3">
          <div style={{ flex: 1 }}>
            <Card>
              <div className="flex items-center gap-2 mb-2">
                <input className="flex-1 border border-[color:var(--border)] rounded-2xl px-3 py-2 bg-[color:var(--panel)] text-[color:var(--text)]" value={name} onChange={(e) => setName(e.target.value)} />
                <Button variant="primary" onClick={save}>{isCreate ? 'Create' : 'Save'}</Button>
              </div>
              <textarea className="w-full border border-[color:var(--border)] rounded-2xl px-3 py-2 bg-[color:var(--panel)] text-[color:var(--text)]" style={{ height: 480 }} value={json} onChange={(e) => setJson(e.target.value)} />
              {status && <div className="text-xs text-[color:var(--muted)] mt-2">{status}</div>}
            </Card>
          </div>
          <div style={{ width: 360 }}>
            <Card>
              <CardHeader title="Quick Run (config64)" />
              <div className="text-xs text-[color:var(--muted)] mb-2">Generates a base64 URL to launch a configured scenario run.</div>
              <div className="text-xs text-[color:var(--muted)] break-words">{config64 || '(invalid config)'}</div>
              <div className="flex items-center gap-2 mt-2">
                <Button variant="secondary" disabled={!config64} onClick={() => navigator.clipboard.writeText(`# /scenarios/configured/${config64}`)}>Copy Hash URL</Button>
                <Link to={`/scenarios/configured/${config64}`} className="inline-flex items-center gap-2 px-3 py-2 rounded-2xl text-sm border border-[color:var(--border)] bg-[color:var(--panel)]">Open</Link>
              </div>
            </Card>
          </div>
        </div>
      )}
    </Layout>
  );
}

function ConfiguredPage() {
  const { config64 } = useParams<{ config64: string }>();
  const [error, setError] = useState<string | null>(null);
  const [conversationId, setConversationId] = useState<number | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    (async () => {
      try {
        if (!config64) throw new Error('Missing config');
        const json = atob(config64.replace(/-/g, '+').replace(/_/g, '/'));
        const payload = JSON.parse(json);
        const result = await wsRpcCall<{ conversationId: number }>('createConversation', payload);
        setConversationId(result.conversationId);
      } catch (e) {
        setError((e as Error).message);
      }
    })();
  }, [config64]);

  return (
    <Layout>
      {error && <Card className="text-[color:var(--danger)]">Error: {error}</Card>}
      {!error && conversationId && (
        <Card>
          <div>Conversation created: #{conversationId}</div>
          <div className="mt-2 flex items-center gap-2">
            <Button variant="secondary" onClick={(e) => { e.preventDefault(); window.open(`/watch/#/conversation/${conversationId}`, '_blank'); }}>Open in Watch</Button>
          </div>
        </Card>
      )}
      {!error && !conversationId && <div className="muted">Creating conversation…</div>}
    </Layout>
  );
}

function RunPage() {
  const params = useParams<{ scenarioId: string }>();
  const [snap, setSnap] = useState<any | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    (async () => {
      try {
        const s = await http<ScenarioItem>(`/scenarios/${encodeURIComponent(params.scenarioId)}`);
        setSnap(s);
      } catch (e) { setError((e as Error).message); }
    })();
  }, [params.scenarioId]);
  const launch = async () => {
    if (!snap) return;
    setCreating(true);
    try {
      const cfg = snap.config;
      const agents = (cfg.agents || []).map((a: any) => ({ id: a.agentId || a.id, displayName: (a.agentId || a.id), config: { model: '' } }));
      const startingAgentId = agents[0]?.id || '';
      const result = await wsRpcCall<{ conversationId: number }>('createConversation', { meta: { title: `${snap.name} - run`, scenarioId: cfg?.metadata?.id || params.scenarioId, agents, startingAgentId } });
      navigate(`/scenarios/configured/${btoa(JSON.stringify({ meta: { title: `${snap.name} - run`, scenarioId: cfg?.metadata?.id || params.scenarioId, agents, startingAgentId } })).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`);
      window.open(`/watch/#/conversation/${result.conversationId}`, '_blank');
    } catch (e) { setError((e as Error).message); } finally { setCreating(false); }
  };
  return (
    <Layout>
      {error && <Card className="text-[color:var(--danger)]">Error: {error}</Card>}
      {snap && (
        <Card>
          <div className="font-semibold">{snap.name}</div>
          <div className="text-xs text-[color:var(--muted)] mt-1 mb-2">{snap.id}</div>
          <Button variant="primary" onClick={launch} disabled={creating}>{creating ? 'Launching…' : 'Launch + Open Watch'}</Button>
        </Card>
      )}
      {!error && !snap && <div className="text-xs text-[color:var(--muted)]">Loading…</div>}
    </Layout>
  );
}

function App() {
  return (
    <Router>
      <AppLayout>
        <Routes>
          <Route path="/" element={<Navigate to="/scenarios" replace />} />
          <Route path="/scenarios" element={<ScenarioLandingPage />} />
          <Route path="/scenarios/create" element={<ScenarioBuilderPage />} />
          <Route path="/scenarios/:scenarioId" element={<ScenarioBuilderPage />} />
          <Route path="/scenarios/:scenarioId/edit" element={<ScenarioBuilderPage />} />
          <Route path="/scenarios/:scenarioId/run" element={<ScenarioRunPage />} />
          <Route path="/scenarios/:scenarioId/external-mcp-client/:config64" element={<ScenarioPluginPage />} />
          <Route path="/scenarios/:scenarioId/external-a2a-client/:config64" element={<ScenarioA2APreLaunchPage />} />
          <Route path="/scenarios/configured/:config64" element={<ScenarioConfiguredPage />} />
          <Route path="/scenarios/created/:conversationId" element={<ScenarioConfiguredPage />} />
        </Routes>
      </AppLayout>
    </Router>
  );
}

const root = ReactDOM.createRoot(document.getElementById('root')!);
root.render(<App />);
