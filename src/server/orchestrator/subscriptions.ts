import type { UnifiedEvent } from '$src/types/event.types';
import type { EventListener, SubscribeFilter, GuidanceEvent } from '$src/types/orchestrator.types';

interface Subscription {
  id: string;
  filter: SubscribeFilter;
  listener: EventListener | ((e: UnifiedEvent | GuidanceEvent) => void);
  includeGuidance?: boolean;
}

export class SubscriptionBus {
  private subs = new Map<string, Subscription>();

  subscribe(filter: SubscribeFilter, listener: EventListener, includeGuidance = false): string {
    const id = crypto.randomUUID();
    this.subs.set(id, { id, filter, listener, includeGuidance });
    return id;
  }

  unsubscribe(id: string) {
    this.subs.delete(id);
  }

  publish(e: UnifiedEvent) {
    for (const s of this.subs.values()) {
      if (s.filter.conversation !== e.conversation) continue;
      if (s.filter.types && !s.filter.types.includes(e.type)) continue;
      if (s.filter.agents && !s.filter.agents.includes(e.agentId)) continue;
      try {
        (s.listener as EventListener)(e);
      } catch (err) {
        // Best-effort fanout
        console.error('Subscription listener error', err);
      }
    }
  }

  // Publish guidance event (transient, not persisted)
  publishGuidance(g: GuidanceEvent) {
    for (const s of this.subs.values()) {
      if (s.filter.conversation !== g.conversation) continue;
      if (!s.includeGuidance) continue; // Only send to subscribers that opted in
      try {
        (s.listener as (e: UnifiedEvent | GuidanceEvent) => void)(g);
      } catch (err) {
        console.error('Guidance listener error', err);
      }
    }
  }
}