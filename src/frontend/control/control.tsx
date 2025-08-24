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
  const [pretty, setPretty] = useState(false)
  const [wrap, setWrap] = useState(false)
  const [copied, setCopied] = useState(false)
  const [sinceInput, setSinceInput] = useState<string>('0')
  const [sseStatus, setSseStatus] = useState<'idle'|'connecting'|'open'|'error'>('idle')
  const esRef = useRef<EventSource | null>(null)
  const logRef = useRef<HTMLPreElement | null>(null)

  function log(text: string) { setEntries((e) => [...e, { when: nowStr(), text }]) }

  useEffect(() => { if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight }, [entries])

  useEffect(() => {
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
    if (!res.ok) { log('Create pair failed: ' + res.status); return }
    const j = await res.json()
    // Clear current log so we only show events for the new pair
    setEntries([])
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
        log(JSON.stringify(ev, null, 2))
      } catch {
        log('Bad event payload')
      }
    }
    es.onerror = () => setSseStatus('error')
  }

  async function hardReset() {
    if (!pairId) return
    const res = await fetch(`/pairs/${pairId}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'hard' }) })
    await res.json().catch(()=>{})
    // Resubscribe from 0
    setEntries([])
    const url = `/pairs/${pairId}/events.log?since=0`
    setSseUrl(url)
    setSinceInput('0')
    try { window.location.hash = `pair=${pairId}&since=0` } catch {}
    subscribe(url)
  }

  const renderedLog = useMemo(() => {
    if (!entries.length) return '(no events yet)'
    const lines: string[] = []
    for (const e of entries) if (e.text != null) lines.push(e.text)
    return lines.join('\n')
  }, [entries])

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(renderedLog || '')
      // ignore UI flash for brevity
    } catch {}
  }

  return (
    <div className="wrap">
      <div className="card">
        <div className="row">
          <button id="btnCreate" className="primary" onClick={createPair}>Create Pair</button>
          <span id="pairBadge" className="small muted">{pairId ? `Pair: ${pairId}` : ''}</span>
          <span style={{ marginLeft: 'auto' }} />
          <button id="btnHard" disabled={!pairId} onClick={hardReset}>Hard reset</button>
        </div>
        {initiatorJoinUrl || responderJoinUrl ? (
          <div className="row links" style={{ marginTop: 10 }}>
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
          <div className="row" style={{ gap: 6 }}>
            <button id="btnCopy" onClick={copyLog}>Copy</button>
          </div>
        </div>
        {sseUrl && (
          <div className="small muted" style={{ marginTop: 6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            SSE: <code id="sseUrl" style={{ display:'inline-block', maxWidth:'60ch', overflow:'hidden', textOverflow:'ellipsis', verticalAlign:'bottom' }}>{sseUrl}</code>
          </div>
        )}
        <pre
          id="log"
          style={{ maxHeight: 'none', overflowX: 'auto', overflowY: 'visible', whiteSpace: 'pre', overflowWrap: 'normal' }}
        >
          {renderedLog}
        </pre>
      </div>
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ControlApp />)
