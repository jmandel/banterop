import React from 'react';
import { ExternalLink } from 'lucide-react';
import { useAppStore } from '../state/store';

function Dot({ ok }:{ ok:boolean|undefined }) {
  const cls = ok === undefined ? 'bg-gray-300' : (ok ? 'bg-green-500' : 'bg-rose-500');
  return <span className={`inline-block w-2 h-2 rounded-full ${cls}`} title={ok===undefined? 'Unknown' : (ok ? 'Valid' : 'Invalid')} />;
}

export function WireLogCard({ max=30, bare=false }:{ max?: number; bare?: boolean }) {
  const entries = useAppStore(s => s.wire.entries);
  const shown = entries.slice(-max);

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
                if (w.protocol === 'a2a') {
                  return <span>{w.dir === 'outbound' ? 'send A2A' : 'receive A2A'}</span>;
                }
                if (w.protocol === 'mcp') {
                  const tool = String(w.method || '').trim();
                  const name = tool ? ` [${tool}]` : '';
                  return <span>{w.dir === 'outbound' ? `call MCP${name}` : `result MCP${name}`}</span>;
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
