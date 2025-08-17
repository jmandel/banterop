import React, { useRef, useEffect } from "react";
import { Card, CardHeader, Badge } from "../../../ui";

type FrontMsg = { id: string; role: "you" | "planner" | "system"; text: string };
type AgentLogEntry = { 
  id: string; 
  role: "planner" | "agent"; 
  text: string; 
  partial?: boolean; 
  attachments?: Array<{ 
    name: string; 
    mimeType: string; 
    bytes?: string; 
    uri?: string;
  }>; 
};

interface DualConversationViewProps {
  frontMessages: FrontMsg[];
  agentLog: AgentLogEntry[];
  plannerStarted: boolean;
  onOpenAttachment?: (name: string, mimeType: string, bytes?: string, uri?: string) => void;
  // Message input props
  input: string;
  onInputChange: (value: string) => void;
  onSendMessage: (text: string) => void;
  connected: boolean;
  busy: boolean;
}

export const DualConversationView: React.FC<DualConversationViewProps> = ({
  frontMessages,
  agentLog,
  plannerStarted,
  onOpenAttachment,
  input,
  onInputChange,
  onSendMessage,
  connected,
  busy,
}) => {
  const frontLogRef = useRef<HTMLDivElement | null>(null);
  const agentLogRef = useRef<HTMLDivElement | null>(null);
  const [frontAutoScroll, setFrontAutoScroll] = React.useState(true);
  const [agentAutoScroll, setAgentAutoScroll] = React.useState(true);

  // Auto-scroll to bottom when new messages arrive, unless user has scrolled up
  useEffect(() => {
    const el = frontLogRef.current;
    if (el && frontAutoScroll) {
      el.scrollTop = el.scrollHeight;
    }
  }, [frontMessages.length, frontAutoScroll]);

  useEffect(() => {
    const el = agentLogRef.current;
    if (el && agentAutoScroll) {
      el.scrollTop = el.scrollHeight;
    }
  }, [agentLog.length, agentAutoScroll]);
  
  // Check if user has scrolled away from bottom
  const handleFrontScroll = () => {
    const el = frontLogRef.current;
    if (el) {
      const isAtBottom = Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 10;
      setFrontAutoScroll(isAtBottom);
    }
  };
  
  const handleAgentScroll = () => {
    const el = agentLogRef.current;
    if (el) {
      const isAtBottom = Math.abs(el.scrollHeight - el.scrollTop - el.clientHeight) < 10;
      setAgentAutoScroll(isAtBottom);
    }
  };

  const fileIcon = (mime: string): string => {
    const m = (mime || "").toLowerCase();
    if (m.startsWith("image/")) return "🖼️";
    if (m.includes("pdf")) return "📄";
    if (m.startsWith("text/")) return "📃";
    if (m.includes("word") || m.includes("msword") || m.includes("officedocument"))
      return "📄";
    if (m.includes("sheet") || m.includes("excel")) return "📊";
    return "📎";
  };

  const getMessageStyle = (role: string) => {
    if (role === "you") return "justify-self-end bg-indigo-600 text-white";
    if (role === "planner") return "justify-self-start bg-white border-gray-200";
    if (role === "agent") return "justify-self-end bg-blue-50 text-blue-900";
    return "justify-self-center border-dashed text-gray-500 bg-transparent";
  };

  return (
    <div className="grid gap-4 2xl:grid-cols-2 grid-cols-1">
      {/* User ↔ Planner Conversation */}
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="bg-gradient-to-r from-indigo-500 to-purple-500 text-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-lg">User ↔ Planner</h3>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium">You</span>
              <span className="text-white/60">→</span>
              <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium">Planner</span>
            </div>
          </div>
        </div>
        
        <div 
          className="h-[400px] overflow-y-auto p-6 bg-gray-50" 
          ref={frontLogRef}
          onScroll={handleFrontScroll}
        >
          <div className="space-y-3">
            {frontMessages.map((m) => (
              <div
                key={m.id}
                className={`max-w-[75%] ${m.role === "you" ? "ml-auto" : m.role === "system" ? "mx-auto" : ""}`}
              >
                <div className={`px-4 py-3 rounded-2xl shadow-sm ${
                  m.role === "you" 
                    ? "bg-indigo-600 text-white ml-auto" 
                    : m.role === "planner"
                    ? "bg-white border border-gray-200"
                    : "bg-yellow-50 border border-yellow-200 text-yellow-800 text-sm italic text-center"
                }`}>
                  {m.text}
                </div>
              </div>
            ))}
            {!frontMessages.length && (
              <div className="text-center py-12">
                <div className="text-gray-400 mb-2">
                  <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
                  </svg>
                </div>
                <p className="text-sm text-gray-500">
                  {plannerStarted
                    ? "Start a conversation with the planner"
                    : "Configure and start the planner first"}
                </p>
              </div>
            )}
          </div>
        </div>
        
        {/* Message Input */}
        <div className="border-t border-gray-200 p-4 bg-white">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={(e) => onInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (connected && plannerStarted && input.trim() && !busy) {
                    onSendMessage(input);
                  }
                }
              }}
              disabled={!plannerStarted}
              className="flex-1 px-4 py-2 border border-gray-300 rounded-full focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
              placeholder={plannerStarted ? "Type your message..." : "Start the planner to send messages"}
            />
            <button
              onClick={() => onSendMessage(input)}
              disabled={!connected || !plannerStarted || !input.trim() || busy}
              className="px-6 py-2 bg-indigo-600 text-white rounded-full hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Send
            </button>
          </div>
          <p className="text-xs text-gray-500 mt-2">
            Press <kbd className="px-1 py-0.5 bg-gray-100 rounded text-xs">Enter</kbd> to send
          </p>
        </div>
      </div>

      {/* Planner ↔ Agent Conversation */}
      <div className="bg-white rounded-2xl shadow-lg border border-gray-100 overflow-hidden">
        <div className="bg-gradient-to-r from-blue-500 to-cyan-500 text-white p-4">
          <div className="flex items-center justify-between">
            <h3 className="font-bold text-lg">Planner ↔ Agent</h3>
            <div className="flex items-center gap-2">
              <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium">Planner</span>
              <span className="text-white/60">→</span>
              <span className="px-2 py-1 bg-white/20 rounded-full text-xs font-medium">Agent</span>
            </div>
          </div>
        </div>
        
        <div 
          className="h-[400px] overflow-y-auto p-6 bg-gray-50" 
          ref={agentLogRef}
          onScroll={handleAgentScroll}
        >
          <div className="space-y-3">
            {agentLog.map((m) => (
              <div
                key={m.id}
                className={`max-w-[75%] ${m.role === "agent" ? "ml-auto" : ""}`}
              >
                <div className={`px-4 py-3 rounded-2xl shadow-sm ${
                  m.role === "planner"
                    ? "bg-white border border-gray-200"
                    : "bg-blue-50 border border-blue-200 ml-auto"
                } ${m.partial ? "opacity-60 italic" : ""}`}>
                  <div className="whitespace-pre-wrap break-words">{m.text}</div>
                  {m.attachments && m.attachments.length > 0 && (
                    <div className="flex items-center gap-2 flex-wrap mt-3 pt-3 border-t border-gray-200">
                      {m.attachments.map((a, idx) => (
                        <button
                          key={`${m.id}:att:${idx}`}
                          title={`${a.mimeType}`}
                          onClick={() => onOpenAttachment?.(a.name, a.mimeType, a.bytes, a.uri)}
                          className="inline-flex items-center gap-1 px-2 py-1 bg-white rounded-lg border border-gray-200 hover:bg-gray-50 text-xs font-medium text-gray-700 cursor-pointer transition-colors"
                        >
                          <span>{fileIcon(a.mimeType)}</span>
                          <span>{a.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
            {!agentLog.length && (
              <div className="text-center py-12">
                <div className="text-gray-400 mb-2">
                  <svg className="w-16 h-16 mx-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M17 8h2a2 2 0 012 2v6a2 2 0 01-2 2h-2v4l-4-4H9a1.994 1.994 0 01-1.414-.586m0 0L11 14h4a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2v4l.586-.586z" />
                  </svg>
                </div>
                <p className="text-sm text-gray-500">
                  Agent conversation will appear here
                </p>
              </div>
            )}
          </div>
        </div>
        
        <div className="bg-gray-100 px-4 py-2 text-center">
          <p className="text-xs text-gray-600 font-medium">Live A2A Task Transcript</p>
        </div>
      </div>
    </div>
  );
};