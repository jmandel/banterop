import type { UnifiedEvent } from './event.types';
import type { ConversationMeta } from './conversation.meta';
import type { ScenarioConfiguration } from './scenario-configuration.types';

export interface ConversationSnapshot {
  conversation: number;
  status: 'active' | 'completed';
  metadata: ConversationMeta;
  events: UnifiedEvent[];
  lastClosedSeq: number;
  // Optional fields populated when includeScenario is true
  scenario?: ScenarioConfiguration | null;
  runtimeMeta?: ConversationMeta;
}

export interface SubscribeFilter {
  conversation: number;
  types?: Array<'message' | 'trace' | 'system'>;
  agents?: string[];
}

export type EventListener = (e: UnifiedEvent) => void;

export interface OrchestratorConfig {
  idleTurnMs?: number; // optional watchdog for open turns
  // When true, disables the guidance heartbeat timer (useful in tests)
  disableHeartbeat?: boolean;
  // Max turns per conversation if not overridden in metadata.config.maxTurns
  maxTurnsDefault?: number;
}

export interface SchedulePolicyInput {
  snapshot: ConversationSnapshot;
  lastEvent?: UnifiedEvent;
}

export type ScheduleDecision =
  | { kind: 'none' }
  | { kind: 'agent'; agentId: string; note?: string };

export interface SchedulePolicy {
  decide(input: SchedulePolicyInput): ScheduleDecision;
}

// Guidance event type (transient, not persisted)
export interface GuidanceEvent {
  type: 'guidance';
  conversation: number;
  seq: number; // Monotone cursor (can be fractional)
  nextAgentId: string;
  // start_turn: begin the next turn (no open turn currently)
  // continue_turn: continue the currently open turn (owned by nextAgentId)
  kind: 'start_turn' | 'continue_turn';
  deadlineMs?: number;
  turn?: number; // optional, current or next turn number
}
