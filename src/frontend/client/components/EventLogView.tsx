import React from 'react';

export type UnifiedEvent = {
  seq: number;
  timestamp: string;
  type: 'agent_message' | 'trace' | 'planner_ask_user' | 'user_reply' | 'tool_call' | 'tool_result' | 'send_to_remote_agent' | 'send_to_user' | 'read_attachment';
  agentId: string;
  payload: any;
};

export const EventLogView: React.FC<{ events: UnifiedEvent[]; busy?: boolean }>
  = ({ events, busy = false }) => {
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
      <div className={`relative bg-gradient-to-r from-slate-500 to-slate-600 text-white p-4`}>
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-lg">Agent Event Log (read-only)</h3>
          <div className="flex items-center gap-2">
            {busy && (
              <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium" title="Completions in progress">
                Thinking…
              </span>
            )}
            <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium">
              {events.length} events
            </span>
          </div>
        </div>
      </div>
      <div className="max-h-[320px] overflow-y-auto p-4 bg-gray-50">
        <ul className="space-y-2">
          {events.map((e) => (
            <li key={e.seq} className="bg-white border border-gray-200 rounded-lg p-3">
              <div className="text-xs text-gray-500 flex items-center justify-between">
                <span>#{e.seq} • {new Date(e.timestamp).toLocaleTimeString()} • {e.type}</span>
                <span className="font-mono">{e.agentId}</span>
              </div>
              <div className="mt-2 text-sm text-gray-800 whitespace-pre-wrap break-words">
                {e.type === 'agent_message' && (
                  <>
                    <div>{String(e.payload?.text || '')}</div>
                    {Array.isArray(e.payload?.attachments) && e.payload.attachments.length > 0 && (
                      <div className="mt-1 text-xs text-gray-600">Attachments: {e.payload.attachments.map((a: any)=>a?.name).filter(Boolean).join(', ')}</div>
                    )}
                  </>
                )}
                {e.type === 'user_reply' && (
                  <div className="italic">{String(e.payload?.text || '')}</div>
                )}
                {e.type === 'planner_ask_user' && (
                  <div className="italic text-indigo-700">Q: {String(e.payload?.question || '')}</div>
                )}
                {e.type === 'tool_call' && (
                  <>
                    <div className="font-mono">CALL {String(e.payload?.name || '')}</div>
                    {typeof e.payload?.reasoning === 'string' && e.payload.reasoning && (
                      <div className="mt-1 text-xs text-gray-700">Reasoning: {e.payload.reasoning}</div>
                    )}
                    <div className="mt-1 text-xs text-gray-600">args: {JSON.stringify(e.payload?.args ?? {})}</div>
                  </>
                )}
                {e.type === 'send_to_remote_agent' && (
                  <>
                    <div className="font-mono">Send to remote agent</div>
                    {typeof e.payload?.reasoning === 'string' && e.payload.reasoning && (
                      <div className="mt-1 text-xs text-gray-700">Reasoning: {e.payload.reasoning}</div>
                    )}
                    {e.payload?.text && (
                      <div className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{e.payload.text}</div>
                    )}
                    {Array.isArray(e.payload?.attachments) && e.payload.attachments.length > 0 && (
                      <div className="mt-1 text-xs text-gray-600">Attachments: {e.payload.attachments.map((a: any)=>a?.docId || a?.name).filter(Boolean).join(', ')}</div>
                    )}
                  </>
                )}
                {e.type === 'send_to_user' && (
                  <>
                    <div className="font-mono">Send to user</div>
                    {typeof e.payload?.reasoning === 'string' && e.payload.reasoning && (
                      <div className="mt-1 text-xs text-gray-700">Reasoning: {e.payload.reasoning}</div>
                    )}
                    <div className="mt-1 text-sm text-gray-800 whitespace-pre-wrap">{String(e.payload?.text || '')}</div>
                  </>
                )}
                {e.type === 'read_attachment' && (
                  <>
                    <div className="font-mono">Read attachment</div>
                    <div className="mt-1 text-xs text-gray-600">args: {JSON.stringify(e.payload?.args ?? {})}</div>
                    {e.payload?.result && (
                      <div className="mt-1 text-xs text-gray-600">result: {JSON.stringify(e.payload?.result ?? {})}</div>
                    )}
                  </>
                )}
                {e.type === 'tool_result' && (() => {
                  const filenames: string[] = Array.isArray((e as any)?.payload?.filenames)
                    ? (e as any).payload.filenames
                    : [];
                  if (filenames.length) {
                    return (
                      <div className="text-xs text-gray-700 space-y-1">
                        {filenames.map((name, i) => (
                          <pre key={i} className="bg-white border border-gray-200 rounded p-2 overflow-auto">
{`<tool_result filename="${name}">
…
</tool_result>`}
                          </pre>
                        ))}
                      </div>
                    );
                  }
                  // Fallback: if result contains documents, render their filenames
                  const res: any = (e as any)?.payload?.result;
                  const docs: any[] = Array.isArray(res?.documents) ? res.documents : [];
                  const single = (res && typeof res === 'object' && (res.name || res.docId)) ? [res] : [];
                  const all = docs.length ? docs : single;
                  if (all.length) {
                    return (
                      <div className="text-xs text-gray-700 space-y-1">
                        {all.map((d: any, i: number) => {
                          const name = String(d?.name || d?.docId || `result_${i+1}`);
                          const hasContent = typeof d?.content === 'string' || typeof d?.text === 'string';
                          return (
                            <pre key={i} className="bg-white border border-gray-200 rounded p-2 overflow-auto">
{`<tool_result filename="${name}">
${hasContent ? '…' : ''}
</tool_result>`}
                            </pre>
                          );
                        })}
                      </div>
                    );
                  }
                  // Last resort: show raw JSON
                  return (
                    <div className="text-xs text-gray-600">result: {JSON.stringify(res ?? {})}</div>
                  );
                })()}
                {e.type === 'trace' && (
                  <div className="text-xs text-gray-600">{JSON.stringify(e.payload)}</div>
                )}
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
};
