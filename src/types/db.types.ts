// Database Schema Types
// This file contains all database row schema definitions

// ============= Database Schema Types =============

export interface ConversationRow {
  id: string;
  name: string | null;
  created_at: string; // ISO timestamp
  status: string;
  metadata: string; // JSON
  agents: string; // JSON array of AgentId
}

export interface ConversationTurnRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  timestamp: string; // ISO timestamp
  content: string;
  metadata: string | null; // JSON
  trace_ids: string; // JSON array of trace IDs
  status: string; // 'in_progress' | 'completed'
  started_at: string;
  completed_at: string | null;
  is_final_turn: number; // SQLite INTEGER (0 or 1)
}

export interface TraceEntryRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  turn_id: string | null; // Can be null if not yet associated with a turn
  timestamp: string; // ISO timestamp
  type: string;
  data: string; // JSON containing type-specific fields
}

export interface UserQueryRow {
  id: string;
  conversation_id: string;
  agent_id: string;
  created_at: string;
  question: string;
  context: string | null; // JSON
  status: string; // pending, answered, timeout
  response: string | null;
  responded_at: string | null;
}

export interface AgentTokenRow {
  token: string;
  conversation_id: string;
  agent_id: string;
  created_at: string;
  expires_at: string;
}

export interface ScenarioRow {
  id: string;
  name: string;
  description: string | null;
  created_at: string;
  updated_at: string;
  metadata: string | null; // JSON
}

export interface ScenarioVersionRow {
  id: string;
  scenario_id: string;
  version_number: number;
  configuration: string; // JSON
  created_at: string;
  is_active: boolean;
}