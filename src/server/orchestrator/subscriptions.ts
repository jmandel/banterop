import type { UnifiedEvent } from '$src/types/event.types';
import type { EventListener, SubscribeFilter } from '$src/types/orchestrator.types';

interface Subscription {
  id: string;
  filter: SubscribeFilter;
  listener: EventListener;
}

export class SubscriptionBus {
  private subs = new Map<string, Subscription>();

  subscribe(filter: SubscribeFilter, listener: EventListener): string {
    const id = crypto.randomUUID();
    this.subs.set(id, { id, filter, listener });
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
        s.listener(e);
      } catch (err) {
        // Best-effort fanout
        console.error('Subscription listener error', err);
      }
    }
  }
}