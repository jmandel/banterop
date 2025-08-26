import { create } from 'zustand'

type Status = 'idle'|'connecting'|'open'|'error'
type LogEntry = { when: string; ev: any }

type ControlState = {
  pairId?: string
  sseUrl?: string
  initiatorJoinUrl?: string
  responderJoinUrl?: string
  since: number
  status: Status
  pretty: boolean
  wrap: boolean
  entries: LogEntry[]

  setPair(id?: string): void
  setPretty(v: boolean): void
  setWrap(v: boolean): void
  setSince(v: number): void
  clear(): void
  copy(): Promise<void>
  download(): void

  subscribe(url: string): void
  unsubscribe(): void
}

let es: EventSource | null = null

export const useControlStore = create<ControlState>((set, get) => ({
  since: 0,
  status: 'idle',
  pretty: false,
  wrap: false,
  entries: [],

  setPair(pairId) { set({ pairId }) },
  setPretty(v) { set({ pretty: v }) },
  setWrap(v) { set({ wrap: v }) },
  setSince(v) { set({ since: v }) },

  clear() { set({ entries: [] }) },
  async copy() {
    const text = (get().entries || []).map(e => JSON.stringify(e.ev)).join('\n')
    try { await navigator.clipboard.writeText(text) } catch {}
  },
  download() {
    const blob = new Blob([(get().entries || []).map(e => JSON.stringify(e.ev)).join('\n')], { type: 'text/plain' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = `events-${get().pairId || 'unknown'}.log`
    a.click()
  },

  subscribe(url) {
    get().unsubscribe()
    es = new EventSource(url)
    set({ sseUrl: url, status: 'connecting' })
    es.onopen = () => set({ status: 'open' })
    es.onerror = () => set({ status: 'error' })
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data)
        const ev = payload.result
        set(s => ({ entries: [...s.entries, { when: new Date().toLocaleTimeString(), ev }] }))
      } catch {}
    }
  },
  unsubscribe() { try { es?.close() } catch {} finally { es = null; set({ status: 'idle' }) } },
}))

