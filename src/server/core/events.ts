type PairCreatedEvent = { seq: number; pairId: string; type: 'pair-created' };
type EpochBeginEvent = { seq: number; pairId: string; type: 'epoch-begin'; epoch: number };
type BackchannelEvent = { seq: number; pairId: string; type: 'backchannel'; action: string };
type StateEvent = { seq: number; pairId: string; type: 'state'; epoch: number; states: { initiator: string; responder: string }; status?: { message?: any } };
type ResetCompleteEvent = { seq: number; pairId: string; type: 'reset-complete'; epoch: number };
type MessageEvent = { seq: number; pairId: string; type: 'message'; epoch: number; messageId: string; message: any };

type Event = PairCreatedEvent | EpochBeginEvent | BackchannelEvent | StateEvent | ResetCompleteEvent | MessageEvent;

export function createEventStore(opts?: { maxPerPair?: number }) {
  const store = new Map<string, Event[]>()
  let seq = 0
  const maxPerPair = Math.max(100, Math.floor(opts?.maxPerPair ?? 5000))
  const waiters = new Map<string, Array<() => void>>()

  function push(pairId: string, ev: Omit<Event, 'seq'|'pairId'>) {
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

  function listMessagesForEpoch(pairId: string, epoch: number): Array<{ messageId: string; message: any }> {
    const arr = store.get(pairId) ?? []
    const out: Array<{ messageId: string; message: any }> = []
    for (const e of arr) {
      if (e.type === 'message' && e.epoch === epoch) out.push({ messageId: e.messageId, message: e.message })
    }
    return out
  }

  return { push, stream, listSince, listMessagesForEpoch }
}
