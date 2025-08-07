import type { UnifiedEvent } from './event.types';
import type { ConversationMeta } from './conversation.meta';

export interface ConversationSnapshot {
  conversation: number;
  status: 'active' | 'completed';
  metadata: ConversationMeta;
  events: UnifiedEvent[];
}

export interface SubscribeFilter {
  conversation: number;
  types?: Array<'message' | 'trace' | 'system'>;
  agents?: string[];
}

export type EventListener = (e: UnifiedEvent) => void;

export interface OrchestratorConfig {
  idleTurnMs?: number; // optional watchdog for open turns
}

export interface SchedulePolicyInput {
  snapshot: ConversationSnapshot;
  lastEvent?: UnifiedEvent;
}

export type ScheduleDecision =
  | { kind: 'none' }
  | { kind: 'internal'; agentId: string }
  | { kind: 'external'; candidates: string[]; note?: string };

export interface SchedulePolicy {
  decide(input: SchedulePolicyInput): ScheduleDecision;
}

// Guidance event type (transient, not persisted)
export interface GuidanceEvent {
  type: 'guidance';
  conversation: number;
  seq: number; // Monotone cursor (can be fractional)
  nextAgentId: string;
  deadlineMs?: number;
}