export class Rpc {
  ws: WebSocket;
  nextId = 1;
  inflight = new Map<number, (msg: any) => void>();
  onEvent?: (e:any)=>void;
  onGuidance?: (g:any)=>void;

  constructor(url = (window as any).DEBUG_CONFIG?.wsUrl) {
    this.ws = new WebSocket(url);
    this.ws.onmessage = (m) => {
      try {
        const msg = JSON.parse(String((m as MessageEvent).data));
        if (msg.id && (msg.result || msg.error)) {
          const cb = this.inflight.get(msg.id); if (cb) { cb(msg); this.inflight.delete(msg.id); }
        } else if (msg.method === 'event') this.onEvent?.(msg.params);
        else if (msg.method === 'guidance') this.onGuidance?.(msg.params);
      } catch {}
    };
  }
  call(method: string, params?: any) {
    const id = this.nextId++;
    this.ws.send(JSON.stringify({ jsonrpc:'2.0', id, method, params }));
    return new Promise<any>((resolve, reject) => this.inflight.set(id, (msg) => msg.error ? reject(msg.error) : resolve(msg.result)));
  }
  async connectWithBacklog(conversationId: number, limit = 500) {
    const page = await this.call('getEventsPage', { conversationId, limit });
    const events = page?.events ?? []; const lastSeq = events.length ? events[events.length - 1].seq : 0;
    const { subId } = await this.call('subscribe', { conversationId, includeGuidance: true, sinceSeq: lastSeq });
    return { subId, events, lastSeq };
  }
}

