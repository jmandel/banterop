type PairCreatedEvent = { seq: number; pairId: string; type: 'pair-created' };
type EpochBeginEvent = { seq: number; pairId: string; type: 'epoch-begin'; epoch: number };
type BackchannelEvent = { seq: number; pairId: string; type: 'backchannel'; action: string };
type StateEvent = { seq: number; pairId: string; type: 'state'; epoch: number; states: { initiator: string; responder: string }; status?: { message?: any } };
type ResetCompleteEvent = { seq: number; pairId: string; type: 'reset-complete'; epoch: number };
type MessageEvent = { seq: number; pairId: string; type: 'message'; epoch: number; messageId: string; message: any };

type Event = PairCreatedEvent | EpochBeginEvent | BackchannelEvent | StateEvent | ResetCompleteEvent | MessageEvent;

export function createEventStore(opts?: { maxPerPair?: number; maxRooms?: number }) {
  const store = new Map<string, Event[]>()
  let seq = 0
  const maxPerPair = Math.max(100, Math.floor(opts?.maxPerPair ?? 1000))
  const maxRooms = Math.max(1, Math.floor(opts?.maxRooms ?? 100))
  const waiters = new Map<string, Array<() => void>>()
  // Simple LRU tracking of rooms: least-recently-used at index 0
  const lru: string[] = []

  function touchRoom(pairId: string) {
    const idx = lru.indexOf(pairId)
    if (idx >= 0) lru.splice(idx, 1)
    lru.push(pairId)
    // Evict if exceeding maxRooms
    while (lru.length > maxRooms) {
      const evictId = lru.shift()!
      try { store.delete(evictId) } catch {}
      try { waiters.delete(evictId) } catch {}
    }
  }

  function push(pairId: string, ev: Omit<Event, 'seq'|'pairId'>) {
    touchRoom(pairId)
    const arr = store.get(pairId) ?? []
    const full = { ...(ev as any), pairId, seq: ++seq } as Event
    arr.push(full)
    if (arr.length > maxPerPair) {
      const excess = arr.length - maxPerPair
      arr.splice(0, excess)
    }
    store.set(pairId, arr)
    // notify waiters
    const ws = waiters.get(pairId)
    if (ws && ws.length) { while (ws.length) { try { ws.shift()?.() } catch {} } }
    return full
  }

  function listSince(pairId: string, since: number) {
    touchRoom(pairId)
    const arr = store.get(pairId) ?? []
    return arr.filter(e => e.seq > since)
  }

  async function* stream(pairId: string, since: number) {
    for (const e of listSince(pairId, since)) yield { result: e }
    let last = (store.get(pairId) ?? []).at(-1)?.seq ?? since
    for (;;) {
      const more = listSince(pairId, last)
      if (more.length) {
        for (const e of more) yield { result: e }
        last = more.at(-1)!.seq
        continue
      }
      // wait for next push
      await new Promise<void>(res => {
        const ws = waiters.get(pairId) ?? []
        ws.push(res)
        waiters.set(pairId, ws)
      })
    }
  }

  // Subscribe to next event for a pair. Returns an unsubscribe function.
  function subscribe(pairId: string, fn: () => void): () => void {
    const ws = waiters.get(pairId) ?? []
    ws.push(fn)
    waiters.set(pairId, ws)
    return () => {
      try {
        const cur = waiters.get(pairId) ?? []
        const i = cur.indexOf(fn)
        if (i >= 0) { cur.splice(i, 1); waiters.set(pairId, cur) }
      } catch {}
    }
  }

  // Efficient one-shot wait: resolve with latest seq if a new event arrives within waitMs; otherwise resolve with 'since'.
  function waitUntil(pairId: string, since: number, waitMs: number): Promise<number> {
    touchRoom(pairId)
    // Fast path: deliver immediately if we already have events beyond 'since'
    try {
      const arr = listSince(pairId, since)
      if (arr.length) return Promise.resolve(arr[arr.length - 1]!.seq)
    } catch {}
    let unsubscribe: (() => void) | null = null
    // Promise that resolves on next push for this pairId
    const onEvent = new Promise<number>((resolve) => {
      const cb = () => {
        try {
          const arr = listSince(pairId, since)
          resolve(arr.length ? arr[arr.length - 1]!.seq : since)
        } catch { resolve(since) }
      }
      unsubscribe = subscribe(pairId, cb)
    })
    // Promise that resolves after waitMs
    let timer: any = null
    const onTimeout = new Promise<number>((resolve) => {
      timer = setTimeout(() => resolve(since), Math.max(0, waitMs))
    })
    // Race event vs timeout
    return Promise.race([onEvent, onTimeout]).finally(() => {
      try { if (unsubscribe) unsubscribe() } catch {}
      try { if (timer) clearTimeout(timer) } catch {}
    })
  }

  function listMessagesForEpoch(pairId: string, epoch: number): Array<{ messageId: string; message: any }> {
    const arr = store.get(pairId) ?? []
    const out: Array<{ messageId: string; message: any }> = []
    for (const e of arr) {
      if (e.type === 'message' && e.epoch === epoch) out.push({ messageId: e.messageId, message: e.message })
    }
    return out
  }

  return { push, stream, listSince, listMessagesForEpoch, waitUntil, subscribe }
}
