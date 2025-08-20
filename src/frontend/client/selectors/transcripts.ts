// Selectors to derive transcripts from the unified event log
import type { UnifiedEvent } from '../types/events';

export type FrontMsg = { id: string; role: 'you' | 'planner' | 'system'; text: string };

export type AgentLogEntry = {
  id: string;
  role: 'planner' | 'agent';
  text: string;
  attachments?: Array<{ name: string; mimeType: string; bytes?: string; uri?: string }>;
  status?: boolean;
};

export function selectFrontMessages(events: UnifiedEvent[]): FrontMsg[] {
  const out: FrontMsg[] = [];
  for (const e of events) {
    if (e.type === 'message' && e.channel === 'user-planner') {
      const role: FrontMsg['role'] = e.author === 'user' ? 'you' : 'planner';
      out.push({ id: String(e.seq), role, text: (e.payload as any).text });
      continue;
    }
    if (e.type === 'trace' && e.channel === 'system') {
      out.push({ id: String(e.seq), role: 'system', text: (e.payload as any).text });
      continue;
    }
    // Status updates should not appear in the user↔agent pane
  }
  return out;
}

export function selectAgentLog(events: UnifiedEvent[]): AgentLogEntry[] {
  const out: AgentLogEntry[] = [];
  for (const e of events) {
    if (e.type === 'message' && e.channel === 'planner-agent') {
      out.push({
        id: String(e.seq),
        role: e.author === 'planner' ? 'planner' : 'agent',
        text: (e.payload as any).text,
        attachments: (e.payload as any).attachments || [],
      });
      continue;
    }
  }
  return out;
}

export function selectLastStatus(events: UnifiedEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as any;
    if (e && e.type === 'status') return e.payload?.state;
  }
  return undefined;
}
