import React from 'react';

export type UnifiedEvent = {
  seq: number;
  timestamp: string;
  type: 'agent_message' | 'trace' | 'planner_ask_user' | 'user_reply' | 'tool_call' | 'tool_result';
  agentId: string;
  payload: any;
};

export const EventLogView: React.FC<{ events: UnifiedEvent[] }>
  = ({ events }) => {
  return (
    <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
      <div className="bg-gradient-to-r from-slate-500 to-slate-600 text-white p-4">
        <div className="flex items-center justify-between">
          <h3 className="font-bold text-lg">Planner Event Log (read-only)</h3>
          <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium">
            {events.length} events
          </span>
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
                {e.type === 'tool_result' && (
                  <div className="text-xs text-gray-600">result: {JSON.stringify(e.payload?.result ?? {})}</div>
                )}
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

