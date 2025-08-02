import type { ConversationEvent, ConversationTurn, TraceEntry } from '$lib/types.js';

export interface EventLogEntry {
  id: string;
  timestamp: Date;
  message: string;
  type: 'info' | 'error';
}

export interface ConversationSummary {
  id: string;
  name: string;
  createdAt: string;
  status: string;
  agents: string[];
  turnCount?: number;
  lastActivity?: Date;
}

export interface TabInfo {
  id: string;
  title: string;
  type: 'global' | 'conversation';
}

export interface ConnectionConfig {
  wsEndpoint: string;
  apiEndpoint: string;
}

export { ConversationEvent, ConversationTurn, TraceEntry };