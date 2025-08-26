type Event = { seq:number; pairId:string; type:'pair-created'|'epoch-begin'|'backchannel'|'state'|'reset-complete'; [k:string]:any }

export function createEventStore() {
  const store = new Map<string, Event[]>()
  let seq = 0

  function push(pairId:string, ev: Omit<Event,'seq'|'pairId'>) {
    const arr = store.get(pairId) ?? []
    const full = { ...ev, pairId, seq: ++seq }
    arr.push(full); store.set(pairId, arr)
    return full
  }
  function listSince(pairId:string, since:number) {
    return (store.get(pairId) ?? []).filter(e => e.seq > since)
  }
  async function* stream(pairId:string, since:number) {
    for (const e of listSince(pairId, since)) yield { result: e }
    let last = (store.get(pairId) ?? []).at(-1)?.seq ?? since
    for (;;) {
      await new Promise(r => setTimeout(r, 100))
      const more = listSince(pairId, last)
      if (more.length) { for (const e of more) yield { result: e }; last = more.at(-1)!.seq }
    }
  }
  return { push, stream, listSince }
}

