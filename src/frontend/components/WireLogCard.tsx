import React from 'react';
import { ExternalLink } from 'lucide-react';
import { useAppStore } from '../state/store';

function Dot({ ok }:{ ok:boolean|undefined }) {
  const cls = ok === undefined ? 'bg-gray-300' : (ok ? 'bg-green-500' : 'bg-rose-500');
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} title={ok===undefined? 'Unknown' : (ok ? 'Valid' : 'Invalid')} />;
}

export function WireLogCard({ max=30, bare=false }:{ max?: number; bare?: boolean }) {
  const entries = useAppStore(s => s.wire.entries);
  const role = useAppStore(s => s.role);
  const mode = useAppStore(s => s.wire.mode) || 'a2a';
  const filtered = React.useMemo(() => {
    if (mode === 'mcp') return entries.filter(e => e.protocol === 'mcp');
    return entries.filter(e => e.protocol === 'a2a');
  }, [entries, mode]);
  const shown = filtered.slice(-max);

  function openJson(e:any, idx:number) {
    try {
      const item = shown[idx];
      const blob = new Blob([JSON.stringify(item.payload, null, 2)], { type:'application/json' });
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(()=>URL.revokeObjectURL(url), 60_000);
    } catch {}
  }

  const Body = (
    <>
      {!bare && (
        <div className="row items-center mb-2">
          <div className="small font-semibold">Wire Messages</div>
          <div className="ml-auto small muted">{entries.length}</div>
        </div>
      )}
      <div className="flex flex-col gap-1" style={{ maxHeight: 280, overflow:'auto' }}>
        {shown.map((w, i) => (
          <button
            key={w.id}
            type="button"
            className="w-full text-left grid grid-cols-[auto_1fr_auto] items-center gap-2 py-0.5 cursor-pointer rounded-md hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-blue-200"
            title="Open full wire entry JSON"
            onClick={(e)=>openJson(e, i)}
            onKeyDown={(e)=>{ if (e.key==='Enter' || e.key===' ') { e.preventDefault(); openJson(e, i); } }}
          >
            <Dot ok={w.validation?.valid} />
            <div className="small truncate" style={{ minWidth: 0 }}>
              <span className="mr-1" title={w.dir}>{w.dir === 'outbound' ? '→' : '←'}</span>
              {(() => {
                const proto = String(w.protocol || '').toUpperCase();
                if (mode === 'a2a') {
                  // Status updates: show explicit source (User/Agent) based on direction
                  if (String(w.kind || '').toLowerCase() === 'status-update') {
                    const label = (w.dir === 'inbound') ? 'A2A Status Update from User' : 'A2A Status Update from Agent';
                    return <span>{label}</span>;
                  }
                  // Messages: label as User/Agent Message based on page role and direction
                  const isInitiator = role === 'initiator';
                  const label = isInitiator
                    ? (w.dir === 'outbound' ? 'A2A User Message' : 'A2A Agent Message')
                    : (w.dir === 'inbound' ? 'A2A User Message' : 'A2A Agent Message');
                  return <span>{label}</span>;
                }
                if (mode === 'mcp') {
                  const tool = String(w.method || '').trim();
                  const suffix = tool ? ` [${tool}]` : '';
                  const isInitiator = role === 'initiator';
                  const isCall = isInitiator ? (w.dir === 'outbound') : (w.dir === 'inbound');
                  const label = isCall ? 'MCP Tool Call' : 'MCP Tool Result';
                  return <span>{`${label}${suffix}`}</span>;
                }
                return <span>{proto}</span>;
              })()}
            </div>
            <span className="justify-self-end text-gray-600 opacity-80">
              <ExternalLink size={16} strokeWidth={1.75} />
            </span>
          </button>
        ))}
        {!shown.length && <div className="small muted">No wire messages yet.</div>}
      </div>
    </>
  );
  return bare ? (Body as any) : (<div className="card">{Body}</div>);
}
