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
  const [legendOpen, setLegendOpen] = useState(false)
  const esRef = useRef<EventSource | null>(null)
  const lastSeqRef = useRef<number>(-1)
  const logRef = useRef<HTMLPreElement | null>(null)

  function log(text: string) {
    setEntries((e) => [...e, { when: nowStr(), text }])
  }
  function logObj(obj: any) {
    setEntries((e) => [...e, { when: nowStr(), obj }])
  }

  useEffect(() => {
    // auto-scroll on new log lines
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight
    }
  }, [entries])

  useEffect(() => {
    // On mount: resume from URL hash if present
    try {
      const hash = window.location.hash.replace(/^#/, '')
      if (hash) {
        const params = new URLSearchParams(hash)
        const hPair = params.get('pair') || undefined
        const hSince = params.get('since')
        if (hPair) {
          setPairId(hPair)
          // derive participant links so they show after reload
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
        if (typeof ev?.seq === 'number') {
          lastSeqRef.current = ev.seq
          if (pairId) {
            try { window.location.hash = `pair=${pairId}&since=${ev.seq}` } catch {}
          }
        }
        log(formatEvent(ev))
      } catch {
        log('Bad event payload')
      }
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

  function clearLog() {
    setEntries([])
    lastSeqRef.current = -1
  }

  function downloadLog() {
    const blob = new Blob([renderedLog], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = pairId ? `events-${pairId}.log` : 'events.log'
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }

  async function hardReset() {
    if (!pairId) return
    const res = await fetch(`/pairs/${pairId}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'hard' }) })
    let nextPair = pairId
    try {
      const j = await res.json()
      if (j?.redirectedTo) nextPair = String(j.redirectedTo)
    } catch {}
    // Clear current log and resubscribe (same or new pair)
    setEntries([])
    lastSeqRef.current = -1
    setPairId(nextPair)
    // Recompute links against current origin
    const origin = window.location.origin
    const a2aUrl = `${origin}/api/bridge/${nextPair}/a2a`
    const tasksUrl = `${origin}/pairs/${nextPair}/server-events`
    setInitiatorJoinUrl(`${origin}/participant/?role=initiator&a2a=${encodeURIComponent(a2aUrl)}`)
    setResponderJoinUrl(`${origin}/participant/?role=responder&a2a=${encodeURIComponent(a2aUrl)}&tasks=${encodeURIComponent(tasksUrl)}`)
    const url = `/pairs/${nextPair}/events.log?since=0`
    setSseUrl(url)
    setSinceInput('0')
    try { window.location.hash = `pair=${nextPair}&since=0` } catch {}
    subscribe(url)
  }

  const renderedLog = useMemo(() => {
    if (!entries.length) return '(no events yet)'
    const lines: string[] = []
    for (const e of entries) {
      if (e.text != null) {
        lines.push(e.text)
      } else if (e.obj != null) {
        if (pretty) {
          const prettyLines = JSON.stringify(e.obj, null, 2).split('\n')
          lines.push(prettyLines[0] ?? '')
          for (let i = 1; i < prettyLines.length; i++) {
            const ln = prettyLines[i]
            if (ln !== undefined) lines.push(ln)
          }
        } else {
          lines.push(JSON.stringify(e.obj))
        }
      }
    }
    return lines.join('\n')
  }, [entries, pretty])

  async function copyLog() {
    try {
      await navigator.clipboard.writeText(renderedLog || '')
      setCopied(true)
      setTimeout(() => setCopied(false), 600)
    } catch {}
  }

  function StatusDot() {
    const color = sseStatus === 'open' ? '#22c55e' : sseStatus === 'connecting' ? '#f59e0b' : '#ef4444'
    const label = sseStatus === 'open' ? 'connected' : sseStatus === 'connecting' ? 'connecting…' : 'closed'
    return <span className="small" title={`SSE ${label}`} style={{display:'inline-flex',alignItems:'center',gap:6}}>
      <span style={{display:'inline-block',width:10,height:10,borderRadius:9999,background:color}} /> {label}
    </span>
  }

  function formatEvent(ev: any): string {
    if (!ev || typeof ev !== 'object') return '???'
    switch (ev.type) {
      case 'pair-created': return `[pair-created] epoch=${ev.epoch}`
      case 'epoch-begin': return `[epoch-begin] epoch=${ev.epoch}`
      case 'reset-start': return `[reset-start] reason=${ev.reason} ${ev.prevEpoch}→${ev.nextEpoch}`
      case 'reset-complete': return `[reset-complete] epoch=${ev.epoch}`
      case 'backchannel': return `[backchannel] ${ev.action}${ev.epoch!=null?` epoch=${ev.epoch}`:''}${ev.taskId?` task=${ev.taskId}`:''}${ev.turn?` turn=${ev.turn}`:''}`
      case 'state':
        if (ev.states) return `[state] initiator=${ev.states.initiator} responder=${ev.states.responder}`
        if (ev.side && ev.state) return `[state] ${ev.side}=${ev.state}`
        return `[state]`;
      case 'message': {
        const next = ev.nextTurn ? ` next=${ev.nextTurn}` : ''
        return `[message] from=${ev.from} finality=${ev.finality}${next} text=${JSON.stringify(ev.text??'')}`
      }
      default:
        return JSON.stringify(ev)
    }
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
            <StatusDot />
            <button aria-label="Legend" title="Legend" onClick={()=>setLegendOpen(true)} style={{padding:'2px 6px'}}>?</button>
          </div>
          <label className="small">Since <input style={{ width: 90 }} type="number" value={sinceInput} onChange={(e)=>setSinceInput(e.target.value)} onBlur={resubscribeSince} /></label>
          <label className="small"><input type="checkbox" checked={pretty} onChange={(e) => setPretty(e.target.checked)} /> Pretty JSON</label>
          <label className="small"><input type="checkbox" checked={wrap} onChange={(e) => setWrap(e.target.checked)} /> Wrap lines</label>
          <div className="row" style={{ gap: 6 }}>
            <button id="btnCopy" onClick={copyLog}>{copied ? 'Copied' : 'Copy'}</button>
            <button onClick={clearLog}>Clear</button>
            <button onClick={downloadLog}>Download</button>
          </div>
        </div>
        {sseUrl && (
          <div className="small muted" style={{ marginTop: 6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            SSE: <code id="sseUrl" style={{ display:'inline-block', maxWidth:'60ch', overflow:'hidden', textOverflow:'ellipsis', verticalAlign:'bottom' }}>{sseUrl}</code>
          </div>
        )}
        <pre
          ref={logRef}
          id="log"
          style={{ maxHeight: 'none', overflowX: 'auto', overflowY: 'visible', whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'anywhere' : 'normal' }}
        >
          {renderedLog}
        </pre>
      </div>
      {legendOpen && (
        <div style={{position:'fixed',inset:0,background:'rgba(0,0,0,0.35)',display:'flex',alignItems:'center',justifyContent:'center'}} onClick={()=>setLegendOpen(false)}>
          <div className="card" style={{width:'min(720px, 92vw)'}} onClick={(e)=>e.stopPropagation()}>
            <div className="row" style={{justifyContent:'space-between',alignItems:'center'}}>
              <strong>Event Legend</strong>
              <button onClick={()=>setLegendOpen(false)}>Close</button>
            </div>
            <div className="small" style={{marginTop:8,lineHeight:1.6}}>
              <div><code>[pair-created]</code>: Pair created; shows starting epoch.</div>
              <div><code>[epoch-begin]</code>: New epoch is active.</div>
              <div><code>[reset-start]</code>/<code>[reset-complete]</code>: Bracket a hard reset.</div>
              <div><code>[backchannel]</code>: Responder instruction (subscribe/unsubscribe) with epoch/task.</div>
              <div><code>[message]</code>: One line per turn — from, finality, optional <code>next</code>, and text.</div>
              <div><code>[state]</code>: Combined task states — <code>initiator=...</code> and <code>responder=...</code>.</div>
              <div style={{marginTop:8}}>Tip: enable “Pretty JSON” to inspect raw event payloads.</div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ControlApp />)
