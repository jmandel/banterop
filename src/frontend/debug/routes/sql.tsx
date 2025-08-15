import React from 'react';
import { API } from '../services/api';

const TEMPLATES = [
  { name: 'Latest 50 events for conversation…', sql: 'SELECT conversation, seq, turn, event, type, finality, ts, agent_id FROM conversation_events WHERE conversation = :conversationId ORDER BY seq DESC LIMIT 50;' },
  { name: 'Open-turn conversations (~60s)', sql: `SELECT c.conversation, c.updated_at FROM conversations c WHERE c.status='active' AND (SELECT finality FROM conversation_events e WHERE e.conversation=c.conversation AND e.type='message' ORDER BY seq DESC LIMIT 1)='none' ORDER BY c.updated_at DESC LIMIT 200;` }
];

export default function SqlPage() {
  const [sql, setSql] = React.useState<string>(TEMPLATES[0]!.sql);
  const [rows, setRows] = React.useState<any[]>([]);
  const [error, setError] = React.useState<string>('');
  const [prompt, setPrompt] = React.useState<string>('List the 25 most recent events with conversation, seq, turn, type.');
  const [models, setModels] = React.useState<{ name: string; models: string[]; defaultModel: string }[]>([]);
  const [model, setModel] = React.useState<string>('');
  const [proposing, setProposing] = React.useState(false);
  const [params, setParams] = React.useState<Record<string, string>>({});
  const [meta, setMeta] = React.useState<{ ms?: number; appliedLimit?: number; rowCount?: number }>({});

  React.useEffect(() => {
    API.llmProviders().then((list) => {
      const usable = list.filter((p: any) => 
        p.name !== 'browserside' && 
        p.name !== 'mock' && 
        p.available !== false
      );
      setModels(usable);
      if (!usable.length) return;
      const m = usable.flatMap(p => p.models).find(m => /lite|flash/i.test(m))
        || usable[0]!.defaultModel
        || usable[0]!.models[0]!
        || '';
      setModel(m);
    }).catch(() => {});
  }, []);

  const paramNames = React.useMemo(() => {
    const names = new Set<string>();
    for (const m of sql.matchAll(/:([a-zA-Z_][\w]*)/g)) names.add(m[1]!);
    return Array.from(names);
  }, [sql]);

  React.useEffect(() => {
    // Ensure param keys exist in state
    setParams((prev) => {
      const next = { ...prev } as Record<string, string>;
      for (const k of paramNames) if (!(k in next)) next[k] = '';
      for (const k of Object.keys(next)) if (!paramNames.includes(k)) delete next[k];
      return next;
    });
  }, [paramNames.join('|')]);

  async function run() {
    setError('');
    const parsedParams: Record<string, string|number|null> = {};
    for (const [k, v] of Object.entries(params)) {
      if (v === '') continue;
      const maybeNum = Number(v);
      parsedParams[k] = Number.isFinite(maybeNum) && /^-?\d+(\.\d+)?$/.test(v) ? maybeNum : v;
    }
    const res = await API.sqlRead(sql, parsedParams);
    if (res.error) {
      setRows([]);
      setMeta({});
      setError(res.error);
    } else {
      setError('');
      setRows(res.rows ?? []);
      setMeta({ ms: res.ms, appliedLimit: res.appliedLimit, rowCount: (res.rows?.length ?? 0) });
    }
  }

  function extractSqlFromText(text: string): string {
    const code = /```sql\s*([\s\S]*?)```/i.exec(text)?.[1]
             || /```\s*([\s\S]*?)```/i.exec(text)?.[1]
             || text;
    const m = /(select[\s\S]*?);/i.exec(code + (code.trim().endsWith(';') ? '' : ';'));
    return (m?.[1] || code).trim();
  }

  async function propose() {
    setProposing(true); setError('');
    try {
      const system = `You write SQLite SELECT queries only. Use only these tables: conversations, conversation_events, attachments, scenarios, idempotency_keys, runner_registry. Never write INSERT/UPDATE/DELETE. Always include a LIMIT <= 200.`;
      const res = await API.llmComplete({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: `Task: ${prompt}\nReturn a single SQL SELECT for SQLite.` },
        ],
        ...(model ? { model } : {}),
        temperature: 0,
      });
      const proposed = extractSqlFromText(res.content || '');
      if (!/^\s*select\b/i.test(proposed)) throw new Error('LLM did not return a SELECT');
      setSql(proposed);
    } catch (e: any) {
      setError(e?.message || 'proposal_failed');
    } finally {
      setProposing(false);
    }
  }

  return (
    <div className="sql-page">
      <h2>SQL Explorer</h2>
      <div className="templates toolbar" style={{ flexWrap:'wrap' }}>
        {TEMPLATES.map(t => <button key={t.name} onClick={()=>setSql(t.sql)}>{t.name}</button>)}
      </div>
      <div className="cols-2">
        <div>
          <div className="panel">
            <div className="toolbar">
              <input value={prompt} onChange={e=>setPrompt(e.target.value)} placeholder="Describe the query you want" style={{ flex:1 }} />
              <select value={model} onChange={e=>setModel(e.target.value)}>
                <option value="">auto</option>
                {models.flatMap(p => p.models.map(m => <option key={m} value={m}>{m}</option>))}
              </select>
              <button onClick={propose} disabled={proposing}>{proposing ? 'Proposing…' : 'Propose'}</button>
            </div>
            <small className="muted">Assistive only. You can edit the SQL below before running.</small>
          </div>
          <div className="panel">
            <textarea value={sql} onChange={(e)=>setSql(e.target.value)} rows={14} />
            {paramNames.length > 0 && (
              <div style={{ marginTop:8 }}>
                <div className="muted" style={{ marginBottom:4 }}>Parameters</div>
                <div className="params-grid">
                  {paramNames.map(name => (
                    <React.Fragment key={name}>
                      <label className="muted" style={{ alignSelf:'center' }}>:{name}</label>
                      <input value={params[name] ?? ''} onChange={(e)=>setParams(p=>({ ...p, [name]: e.target.value }))} placeholder="value" />
                    </React.Fragment>
                  ))}
                </div>
              </div>
            )}
            <div className="toolbar" style={{ justifyContent:'flex-start' }}>
              <button onClick={run}>Run</button>
              <small className="muted">SELECT only; LIMIT auto-applied; 1s timeout</small>
            </div>
            {error && <div className="error">{error}</div>}
          </div>
        </div>
        <div>
          <div className="panel">
            <div className="toolbar" style={{ justifyContent:'space-between', marginBottom:0 }}>
              <div className="muted">Results</div>
              <div className="muted">{meta.rowCount ?? 0} rows{typeof meta.ms==='number' ? ` • ${meta.ms} ms` : ''}{meta.appliedLimit ? ` • limit=${meta.appliedLimit}` : ''}</div>
            </div>
            {rows && rows.length > 0 ? (
              <div className="table-wrap" style={{ marginTop:8 }}>
                <table className="grid">
                  <thead><tr>{Object.keys(rows[0] ?? {}).map(k => <th key={k}>{k}</th>)}</tr></thead>
                  <tbody>{rows.map((r,i) => <tr key={i}>{Object.keys(r).map(k => <td key={k}>{String(r[k])}</td>)}</tr>)}</tbody>
                </table>
              </div>
            ) : (
              <div className="muted" style={{ marginTop:8 }}>No rows</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
