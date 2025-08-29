import React, { useEffect } from 'react'
import { createRoot } from 'react-dom/client'
import { useControlStore } from './store'

function ControlApp() {
  const pairId = useControlStore(s => s.pairId)
  const sseUrl = useControlStore(s => s.sseUrl)
  const initiatorJoinUrl = useControlStore(s => s.initiatorJoinUrl)
  const responderJoinUrl = useControlStore(s => s.responderJoinUrl)
  const pretty = useControlStore(s => s.pretty)
  const wrap = useControlStore(s => s.wrap)
  const since = useControlStore(s => s.since)
  const status = useControlStore(s => s.status)
  const entries = useControlStore(s => s.entries)
  const setPretty = useControlStore(s => s.setPretty)
  const setWrap = useControlStore(s => s.setWrap)
  const setSince = useControlStore(s => s.setSince)
  const setPair = useControlStore(s => s.setPair)
  const subscribe = useControlStore(s => s.subscribe)
  const unsubscribe = useControlStore(s => s.unsubscribe)
  const clear = useControlStore(s => s.clear)
  const copy = useControlStore(s => s.copy)
  const download = useControlStore(s => s.download)

  useEffect(() => {
    const onLoad = () => {
      try {
        const hash = window.location.hash.replace(/^#/, '')
        if (hash) {
          const params = new URLSearchParams(hash)
          const hPair = params.get('pair') || undefined
          const hSince = params.get('since')
          if (hPair) {
            setPair(hPair)
            const origin = window.location.origin
            const cardUrl = `${origin}/api/rooms/${hPair}/.well-known/agent-card.json`
            useControlStore.setState({
              initiatorJoinUrl: `${origin}/client/?agentCardUrl=${encodeURIComponent(cardUrl)}`,
              responderJoinUrl: `${origin}/rooms/${hPair}`,
            })
            const s = hSince ? Number(hSince) : 0
            setSince(Number.isFinite(s) ? s : 0)
            const url = `/api/pairs/${hPair}/events.log?since=${Number.isFinite(s) ? s : 0}`
            subscribe(url)
          }
        }
      } catch {}
    }
    onLoad()
    return () => { try { unsubscribe() } catch {} }
  }, [])

  async function createPair() {
    const res = await fetch('/api/pairs', { method: 'POST' })
    if (!res.ok) return
    const j = await res.json()
    clear()
    setPair(j.pairId)
    useControlStore.setState({
      initiatorJoinUrl: j.links?.initiator?.joinA2a,
      responderJoinUrl: j.links?.responder?.joinA2a,
    })
    const url = `/api/pairs/${j.pairId}/events.log?since=0`
    try { window.location.hash = `pair=${j.pairId}&since=0` } catch {}
    setSince(0)
    subscribe(url)
  }

  async function hardReset() {
    if (!pairId) return
    await fetch(`/api/pairs/${pairId}/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'hard' }) }).catch(()=>{})
    clear()
    const url = `/api/pairs/${pairId}/events.log?since=0`
    try { window.location.hash = `pair=${pairId}&since=0` } catch {}
    setSince(0)
    subscribe(url)
  }

  const renderedLog = React.useMemo(() => {
    if (!entries.length) return '(no events yet)'
    const lines: string[] = []
    for (const e of entries) lines.push(pretty ? JSON.stringify(e.ev, null, 2) : JSON.stringify(e.ev))
    return lines.join('\n')
  }, [entries, pretty])

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
            <span className="pill" title={`SSE: ${status}`}>{status}</span>
          </div>
          <div className="row" style={{ gap: 6, alignItems:'center' }}>
            <label className="small">Since</label>
            <input className="input" style={{ width: 80 }} value={String(since)} onChange={(e)=>setSince(Number(e.target.value||0))} onBlur={()=>{ if (pairId!=null) subscribe(`/api/pairs/${pairId}/events.log?since=${since||0}`) }} />
            <label className="small">Pretty</label>
            <input type="checkbox" checked={pretty} onChange={(e)=>setPretty(e.target.checked)} />
            <label className="small">Wrap</label>
            <input type="checkbox" checked={wrap} onChange={(e)=>setWrap(e.target.checked)} />
            <button onClick={()=>copy()}>Copy</button>
            <button onClick={()=>clear()}>Clear</button>
            <button onClick={()=>download()}>Download</button>
          </div>
        </div>
        {sseUrl && (
          <div className="small muted" style={{ marginTop: 6, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>
            SSE: <code id="sseUrl" style={{ display:'inline-block', maxWidth:'60ch', overflow:'hidden', textOverflow:'ellipsis', verticalAlign:'bottom' }}>{sseUrl}</code>
          </div>
        )}
        <pre id="log" style={{ maxHeight: 'none', overflowX: wrap ? 'auto' : 'auto', overflowY: 'visible', whiteSpace: wrap ? 'pre-wrap' : 'pre', overflowWrap: wrap ? 'anywhere' : 'normal' }}>{renderedLog}</pre>
      </div>
    </div>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<ControlApp />)
