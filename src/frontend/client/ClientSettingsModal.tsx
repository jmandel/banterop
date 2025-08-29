import React from 'react';

type ClientSettings = {
  transport: 'a2a' | 'mcp';
  a2aCardUrl: string;
  mcpUrl: string;
  llm: {
    provider: 'server' | 'client-openai';
    model: string;
    baseUrl?: string; // for client-openai
    apiKey?: string;  // for client-openai
  };
};

export function ClientSettingsModal({
  open,
  value,
  onCancel,
  onSave,
  serverModels,
  variant = 'client',
}: {
  open: boolean;
  value: ClientSettings;
  onCancel: () => void;
  onSave: (next: ClientSettings) => void;
  serverModels: string[];
  variant?: 'client'|'rooms';
}) {
  const [draft, setDraft] = React.useState<ClientSettings>(value);
  React.useEffect(() => { setDraft(value); }, [value, open]);
  const [showKey, setShowKey] = React.useState(false);

  const providerOptions: Array<{ value: ClientSettings['llm']['provider']; label: string }> = [
    { value: 'server', label: "Josh's Hosted Service" },
    { value: 'client-openai', label: 'Use My Own Key (in Browser)' },
  ];

  const modelOptions = draft.llm.provider === 'server'
    ? (serverModels?.length ? serverModels : ['@preset/chitchat'])
    : [];

  function save() { onSave(draft); }

  if (!open) return null;
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', zIndex: 1000 }} onClick={onCancel}>
      <div className="card" style={{ maxWidth: 720, margin: '8vh auto', boxShadow: '0 8px 40px rgba(0,0,0,0.25)' }} onClick={e=>e.stopPropagation()}>
        <div className="row" style={{ alignItems: 'center' }}>
          <h3 style={{ margin: 0, flex: 1 }}>{variant === 'rooms' ? 'Room Settings' : 'Client Settings'}</h3>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '180px 1fr', columnGap: 12, rowGap: 10, marginTop: 12 }}>
          {variant === 'client' && (
            <>
              <div className="small muted" style={{ gridColumn: '1 / -1', marginBottom: 2 }}>Connection</div>
              <div style={{ gridColumn: '1 / -1' }}>
                <div className="row" style={{ gap: 16 }}>
                  <label className="row" style={{ gap: 6 }}>
                    <input type="radio" name="transport" checked={draft.transport==='a2a'} onChange={()=>setDraft({ ...draft, transport:'a2a' })} />
                    <span>A2A (Agent Card)</span>
                  </label>
                  <label className="row" style={{ gap: 6 }}>
                    <input type="radio" name="transport" checked={draft.transport==='mcp'} onChange={()=>setDraft({ ...draft, transport:'mcp' })} />
                    <span>MCP (Model Context Protocol)</span>
                  </label>
                </div>
              </div>

              {draft.transport === 'a2a' && (<>
                <label className="small" style={{ alignSelf: 'center' }}>Agent Card URL</label>
                <input className="input" placeholder="https://…/agent-card.json" value={draft.a2aCardUrl} onChange={e=>setDraft({ ...draft, a2aCardUrl: e.target.value })} />
              </>)}
              {draft.transport === 'mcp' && (<>
                <label className="small" style={{ alignSelf: 'center' }}>MCP URL</label>
                <input className="input" placeholder="https://…/mcp.json" value={draft.mcpUrl} onChange={e=>setDraft({ ...draft, mcpUrl: e.target.value })} />
              </>)}
            </>
          )}

          <div className="small muted" style={{ gridColumn: '1 / -1', marginTop: 8 }}>LLM Defaults</div>
          <label className="small" style={{ alignSelf: 'center' }}>Provider</label>
          <select className="input" value={draft.llm.provider} onChange={e=>{
            const provider = e.target.value as ClientSettings['llm']['provider'];
            const nextModel = (provider === 'server' ? (serverModels[0] || draft.llm.model) : (draft.llm.model || 'qwen/qwen3-235b-a22b-2507'));
            const nextBase = provider === 'client-openai' ? (draft.llm.baseUrl || 'https://openrouter.ai/api/v1') : draft.llm.baseUrl;
            setDraft({ ...draft, llm: { provider, model: nextModel, baseUrl: nextBase, apiKey: draft.llm.apiKey } });
          }}>
            {providerOptions.map(p => <option key={p.value} value={p.value}>{p.label}</option>)}
          </select>

          {draft.llm.provider === 'server' ? (<>
            <label className="small" style={{ alignSelf: 'center' }}>Default Model</label>
            <select className="input" value={draft.llm.model} onChange={e=>setDraft({ ...draft, llm: { ...draft.llm, model: e.target.value } })}>
              {modelOptions.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </>) : (<>
            <label className="small" style={{ alignSelf: 'center' }}>Base URL</label>
            <input className="input" placeholder="https://openrouter.ai/api/v1" value={draft.llm.baseUrl || ''} onChange={e=>setDraft({ ...draft, llm: { ...draft.llm, baseUrl: e.target.value } })} />

            <label className="small" style={{ alignSelf: 'center' }}>API Key</label>
            <div className="row" style={{ gap: 8 }}>
              <input
                className="input"
                type={showKey ? 'text' : 'password'}
                placeholder="sk-…"
                value={draft.llm.apiKey || ''}
                onChange={e=>setDraft({ ...draft, llm: { ...draft.llm, apiKey: e.target.value } })}
                style={{ flex: 1 }}
              />
              <button
                type="button"
                className="btn"
                onClick={()=>setShowKey(s=>!s)}
                aria-label={showKey ? 'Hide API key' : 'Show API key'}
                title={showKey ? 'Hide API key' : 'Show API key'}
              >
                {showKey ? 'Hide' : 'Show'}
              </button>
            </div>

            <div className="small muted" style={{ gridColumn: '2 / -1' }}>
              OpenRouter is an OpenAI-compatible multi-model gateway that lets you use many providers with one key. Get a key at
              {' '}<a href="https://openrouter.ai/settings/keys" target="_blank" rel="noreferrer">openrouter.ai/settings/keys</a>.
            </div>

            <label className="small" style={{ alignSelf: 'center' }}>Model</label>
            <input className="input" placeholder="qwen/qwen3-235b-a22b-2507" value={draft.llm.model} onChange={e=>setDraft({ ...draft, llm: { ...draft.llm, model: e.target.value } })} />
          </>)}
        </div>

        <div className="row" style={{ justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
          <button className="btn" onClick={onCancel}>Close</button>
          <button className="btn" onClick={save}>Save</button>
        </div>
      </div>
    </div>
  );
}
