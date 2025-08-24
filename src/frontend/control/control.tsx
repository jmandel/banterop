import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'

type LogEntry = { when: string; text?: string; obj?: any }

function nowStr() { return new Date().toLocaleTimeString() }

function ControlApp() {
  const [pairId, setPairId] = useState<string | undefined>(undefined)
  const [sseUrl, setSseUrl] = useState<string | undefined>(undefined)
  const [initiatorJoinUrl, setInitiatorJoinUrl] = useState<string | undefined>()
  const [responderJoinUrl, setResponderJoinUrl] = useState<string | undefined>()
  const [entries, setEntries] = useState<LogEntry[]>([])
  const [pretty, setPretty] = useState(true)
  const [wrap, setWrap] = useState(false)
  const [sinceInput, setSinceInput] = useState<string>('0')
  const [sseStatus, setSseStatus] = useState<'idle'|'connecting'|'open'|'error'>('idle')
  const esRef = useRef<EventSource | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [entries])

  useEffect(() => {
    // Resume from hash
    try {
      const hash = window.location.hash.replace(/^#/, '')
      if (hash) {
        const params = new URLSearchParams(hash)
        const hPair = params.get('pair') || undefined
        const hSince = params.get('since')
        if (hPair) {
          setPairId(hPair)
          const origin = window.location.origin
          const a2aUrl = `${origin}/api/bridge/${hPair}/a2a`
          const tasksUrl = `${origin}/pairs/${hPair}/server-events`
          setInitiatorJoinUrl(`${origin}/participant/?role=initiator&a2a=${encodeURIComponent(a2aUrl)}`)
          setResponderJoinUrl(`${origin}/participant/?role=responder&a2a=${encodeURIComponent(a2aUrl)}&tasks=${encodeURIComponent(tasksUrl)}`)
          const since = hSince ? Number(hSince) : 0
          setSinceInput(String(Number.isFinite(since) ? since : 0))
          const url = `/pairs/${hPair}/events.log?since=${Number.isFinite(since) ? since : 0}`
          setSseUrl(url)
          subscribe(url)
        }
      }
    } catch {}
    return () => { try { esRef.current?.close() } catch {} }
  }, [])

  async function createPair() {
    const res = await fetch('/api/pairs', { method: 'POST' })
    if (!res.ok) return
    const j = await res.json()
    setPairId(j.pairId)
    setInitiatorJoinUrl(j.initiatorJoinUrl)
    setResponderJoinUrl(j.responderJoinUrl)
    const url = `/pairs/${j.pairId}/events.log?since=0`
    setSseUrl(url)
    try { window.location.hash = `pair=${j.pairId}&since=0` } catch {}
    setSinceInput('0')
    subscribe(url)
  }

  function subscribe(url: string) {
    try { esRef.current?.close() } catch {}
    const es = new EventSource(url)
    esRef.current = es
    setSseStatus('connecting')
    es.onopen = () => setSseStatus('open')
    es.onmessage = (e) => {
      try {
        const payload = JSON.parse(e.data)
        const ev = payload.result
        setEntries((prev) => [...prev, { when: nowStr(), obj: ev }])
        if (typeof ev?.seq === 'number') {
          const next = `/pairs/${ev.pairId}/events.log?since=${ev.seq}`
          setSseUrl(next)
          try { window.location.hash = `pair=${ev.pairId}&since=${ev.seq}` } catch {}
        }
      } catch { setEntries((prev) => [...prev, { when: nowStr(), text: e.data }]) }
    }
    es.onerror = () => setSseStatus('error')
  }

  function resubscribeSince() {
    if (!pairId) return
    const since = Number(sinceInput)
    const s = Number.isFinite(since) && since >= 0 ? since : 0
    const url = `/pairs/${pairId}/events.log?since=${s}`
    setSseUrl(url)
    try { window.location.hash = `pair=${pairId}&since=${s}` } catch {}
    subscribe(url)
  }

  async function hardReset() {
    if (!pairId) return
    await fetch(`/pairs/${pairId}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'hard' }) })
    setEntries([])
    const url = `/pairs/${pairId}/events.log?since=0`
    setSseUrl(url)
    setSinceInput('0')
    subscribe(url)
  }

  const rendered = useMemo(() => {
    if (!entries.length) return '(no events yet)'
    return entries.map(e => {
      if (e.obj != null) {
        return JSON.stringify(e.obj, null, pretty ? 2 : 0)
      }
      return e.text || ''
    }).join('\n')
  }, [entries, pretty])

  return (
    <div className="wrap">
      <div className="card">
        <div className="row">
          <button className="primary" onClick={createPair}>Create Pair</button>
          <span className="small muted">{pairId ? `Pair: ${pairId}` : ''}</span>
          <span style={{ marginLeft: 'auto' }} />
          <button disabled={!pairId} onClick={hardReset}>Hard reset</button>
        </div>
        {initiatorJoinUrl || responderJoinUrl ? (
          <div className="row" style={{ marginTop: 10 }}>
            {initiatorJoinUrl && <a href={initiatorJoinUrl} target="_blank">Open Initiator</a>}
            {responderJoinUrl && <a href={responderJoinUrl} target="_blank">Open Responder</a>}
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="row" style={{ alignItems: 'center', gap: 10, justifyContent:'space-between' }}>
          <div className="row" style={{gap:10, alignItems:'center'}}>
            <strong>Events</strong>
          </div>
          <label className="small">Since <input style={{ width: 90 }} type="number" value={sinceInput} onChange={(e)=>setSinceInput(e.target.value)} onBlur={resubscribeSince} /></label>
          <label className="small"><input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> Pretty JSON</label>
          <label className="small"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines</label>
        </div>
        {sseUrl && (
          <div className="small muted" style={{ marginTop: 6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            SSE: <code style={{ display:'inline-block', maxWidth:'60ch', overflow:'hidden', textOverflow:'ellipsis', verticalAlign:'bottom' }}>{sseUrl}</code>
          </div>
        )}
        <pre
          ref={logRef}
          style={{ maxHeight: 'none', overflowX: 'auto', overflowY: 'visible', whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'anywhere' : 'normal' }}
        >
          {rendered}
        </pre>
      </div>
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ControlApp />)
