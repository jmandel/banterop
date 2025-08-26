type Event =
  | ({ seq: number; pairId: string; type: 'pair-created' | 'epoch-begin' | 'backchannel' | 'state' | 'reset-complete' } & Record<string, any>)
  | ({ seq: number; pairId: string; type: 'message'; epoch: number; messageId: string; message: any })

export function createEventStore(opts?: { maxPerPair?: number }) {
  const store = new Map<string, Event[]>()
  let seq = 0
  const maxPerPair = Math.max(100, Math.floor(opts?.maxPerPair ?? 5000))

  function push(pairId: string, ev: any) {
    const arr = store.get(pairId) ?? []
    const full = { ...ev, pairId, seq: ++seq } as Event
    arr.push(full)
    if (arr.length > maxPerPair) {
      const excess = arr.length - maxPerPair
      arr.splice(0, excess)
    }
    store.set(pairId, arr)
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
      await new Promise(r => setTimeout(r, 100))
      const more = listSince(pairId, last)
      if (more.length) {
        for (const e of more) yield { result: e }
        last = more.at(-1)!.seq
      }
    }
  }

  function listMessagesForEpoch(pairId: string, epoch: number): Array<{ messageId: string; message: any }> {
    const arr = store.get(pairId) ?? []
    const out: Array<{ messageId: string; message: any }> = []
    for (const e of arr) {
      if ((e as any).type === 'message' && (e as any).epoch === epoch) out.push({ messageId: (e as any).messageId, message: (e as any).message })
    }
    return out
  }

  return { push, stream, listSince, listMessagesForEpoch }
}
