import type { UnifiedEvent } from './event.types';

export interface ConversationSnapshot {
  conversation: number;
  status: 'active' | 'completed';
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
  emitNextCandidates?: boolean;
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