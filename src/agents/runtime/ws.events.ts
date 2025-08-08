import type { IAgentEvents } from './runtime.interfaces';
import type { StreamEvent } from '$src/agents/clients/event-stream';
import { WsEventStream } from '$src/agents/clients/event-stream';

export class WsEvents implements IAgentEvents {
  constructor(
    private wsUrl: string,
    private options: {
      conversationId: number;
      includeGuidance?: boolean;
      reconnectDelayMs?: number;
      heartbeatIntervalMs?: number;
    }
  ) {}

  subscribe(listener: (ev: StreamEvent) => void): () => void {
    const stream = new WsEventStream(this.wsUrl, {
      conversationId: this.options.conversationId,
      includeGuidance: this.options.includeGuidance ?? true,
      reconnectDelayMs: this.options.reconnectDelayMs ?? 1000,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs ?? 15000,
    });

    let stopped = false;

    // Start consuming the stream
    (async () => {
      try {
        for await (const event of stream) {
          if (stopped) break;
          listener(event);
        }
      } catch (error) {
        console.error('WsEvents stream error:', error);
      }
    })();

    // Return unsubscribe function
    return () => {
      stopped = true;
      stream.close();
    };
  }
}