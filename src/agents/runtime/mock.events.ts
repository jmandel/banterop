import type { IAgentEvents } from './runtime.interfaces';
import type { StreamEvent } from '$src/agents/clients/event-stream';

export class MockEvents implements IAgentEvents {
  private listeners: Array<(ev: StreamEvent) => void> = [];

  subscribe(listener: (ev: StreamEvent) => void): () => void {
    this.listeners.push(listener);
    return () => {
      const index = this.listeners.indexOf(listener);
      if (index >= 0) {
        this.listeners.splice(index, 1);
      }
    };
  }

  // Helper method for tests to emit events
  emit(event: StreamEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}