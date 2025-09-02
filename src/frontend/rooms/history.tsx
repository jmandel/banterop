import React from 'react'
import { createRoot } from 'react-dom/client'
import { AppLayout as SharedAppLayout } from '../ui'
import { ArrowLeft } from 'lucide-react'
import { Markdown } from '../components/Markdown'
import { attachmentHrefFromBase64 } from '../components/attachments'
import type { A2ATask } from '../../shared/a2a-types'
import { a2aToFacts } from '../../shared/a2a-translator'

type EpochSummary = { epoch:number; initiatorTaskId:string; responderTaskId:string; state:string; messageCount:number }

function useRoom() {
  const url = new URL(window.location.href)
  const parts = url.pathname.split('/').filter(Boolean)
  const qp = url.searchParams.get('roomId') || ''
  const roomId = qp || parts[1] || ''
  const base = `${url.origin}`
  const epochs = `${base}/api/rooms/${roomId}/epochs`
  const epoch = (n:number) => `${base}/api/rooms/${roomId}/epochs/${n}`
  const roomHref = `${base}/rooms/${roomId}`
  return { roomId, epochs, epoch, roomHref }
}

async function fetchJson<T=any>(url:string): Promise<T> { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json() }

function parseTaskId(id: string): { role: 'init'|'resp'|null; pairId: string; epoch: number } {
  try {
    const raw = String(id || '')
    const [prefix, rest] = raw.split(':')
    if (!rest) return { role: null, pairId: '', epoch: NaN as any }
    const [pairId, epochStr] = rest.split('#')
    const role = (prefix === 'init' || prefix === 'resp') ? (prefix as any) : null
    const epoch = Number(epochStr)
    return { role, pairId, epoch }
  } catch { return { role: null, pairId: '', epoch: NaN as any } }
}

function HistoryApp() {
  const { roomId, epochs, epoch: epochUrl, roomHref } = useRoom()
  const [list, setList] = React.useState<EpochSummary[]>([])
  const [loadingList, setLoadingList] = React.useState(true)
  const [selected, setSelected] = React.useState<number | null>(null)
  const [viewer, setViewer] = React.useState<'init'|'resp'>('init')
  const [snap, setSnap] = React.useState<A2ATask | null>(null)
  const [loadingSnap, setLoadingSnap] = React.useState(false)
  const [error, setError] = React.useState<string>('')

  React.useEffect(() => {
    (async () => {
      setLoadingList(true)
      try {
        const res = await fetchJson<{ pairId:string; currentEpoch:number; epochs:EpochSummary[] }>(`${epochs}?order=desc`)
        setList(Array.isArray(res.epochs) ? res.epochs : [])
        // Read hash: full task id or epoch number
        const raw = (window.location.hash || '').slice(1)
        const cand = [raw]
        try { cand.push(decodeURIComponent(raw)) } catch {}
        let chosenEpoch: number | null = null
        let chosenViewer: 'init'|'resp' = 'init'
        for (const h of cand) {
          const s = (h || '').trim()
          if (!s) continue
          if (/^(init|resp):/.test(s)) {
            const { role, pairId, epoch } = parseTaskId(s)
            if (Number.isFinite(epoch) && epoch > 0) {
              if (!pairId || pairId === roomId) { chosenEpoch = epoch; chosenViewer = role || 'init'; break }
            }
          } else if (/^\d+$/.test(s)) {
            const n = Number(s)
            if (n > 0) { chosenEpoch = n; break }
          }
        }
        if (chosenEpoch != null) {
          setSelected(chosenEpoch)
          setViewer(chosenViewer)
        } else {
          // Default: most recent
          const first = (Array.isArray(res.epochs) && res.epochs.length) ? res.epochs[0].epoch : null
          setSelected(first)
        }
      } catch (e:any) {
        setError(String(e?.message || e))
      } finally {
        setLoadingList(false)
      }
    })()
  }, [epochs])

  React.useEffect(() => {
    if (selected == null) { setSnap(null); return }
    (async () => {
      setLoadingSnap(true)
      setError('')
      try {
        const s = await fetchJson<A2ATask>(`${epochUrl(selected)}?viewer=${viewer}`)
        setSnap(s)
      } catch (e:any) {
        setError(String(e?.message || e))
        setSnap(null)
      } finally {
        setLoadingSnap(false)
      }
    })()
  }, [selected, viewer])

  // Keep hash in sync with selection so link is shareable
  React.useEffect(() => {
    if (selected == null) return
    const desired = `${viewer}:${roomId}#${selected}`
    const cur = (window.location.hash || '').slice(1)
    // Avoid duplicates or non-semantic changes
    if (cur !== desired) {
      try { window.history.replaceState(null, '', `#${encodeURIComponent(desired)}`) } catch {}
    }
  }, [selected, viewer, roomId])

  // Respond to external hash changes (e.g., paste new link)
  React.useEffect(() => {
    function onHash() {
      const raw = (window.location.hash || '').slice(1)
      const s = (()=>{ try { return decodeURIComponent(raw) } catch { return raw } })()
      if (/^(init|resp):/.test(s)) {
        const { role, pairId, epoch } = parseTaskId(s)
        if (Number.isFinite(epoch) && epoch > 0 && (!pairId || pairId === roomId)) {
          setViewer((role || 'init'))
          setSelected(epoch)
        }
      } else if (/^\d+$/.test(s)) {
        const n = Number(s)
        if (n > 0) setSelected(n)
      }
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [roomId])

  const facts = React.useMemo(() => {
    const f = [] as any[]
    if (snap && (snap as any).kind === 'task') {
      for (const m of (snap.history || [])) f.push(...a2aToFacts(m as any))
      if (snap.status?.message) f.push(...a2aToFacts(snap.status.message as any))
    }
    return f
  }, [snap])

  return (
    <SharedAppLayout
      title="Banterop"
      fullWidth
      breadcrumbs={(
        <>
          <a className="muted" href={roomHref}>Room</a>
          <span className="truncate font-semibold text-gray-900">History: {roomId || '—'}</span>
        </>
      )}
      headerRight={(
        <a
          className="p-1 ml-2 text-gray-600 hover:text-gray-900 bg-transparent border-0 row compact"
          href={roomHref}
          title="Back to Room"
          aria-label="Back to Room"
        >
          <ArrowLeft size={18} strokeWidth={1.75} />
          <span className="hidden sm:inline text-sm">Back to Room</span>
        </a>
      )}
    >
      <div className="wrap">
        {error && (
          <div className="card">
            <div className="small text-red-700">{error}</div>
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-[320px_1fr] gap-3">
          {/* Left: Tasks list (narrow) */}
          <div className="side-panel order-1 lg:order-none">
            <div className="card">
              <div className="row justify-between items-center">
                <div className="small font-semibold">Tasks</div>
              </div>
              {loadingList && <div className="small muted mt-2">Loading…</div>}
              {!loadingList && list.length === 0 && (
                <div className="small muted mt-2">No tasks yet.</div>
              )}
              <div className="flex flex-col gap-1 mt-2">
                {list.map((e) => (
                  <button key={e.epoch}
                    className={`row items-center justify-between w-full text-left rounded px-2 py-1 ${selected===e.epoch ? 'bg-gray-100' : 'hover:bg-gray-50'} cursor-pointer`}
                    onClick={()=>setSelected(e.epoch)}
                  >
                    <div>
                      <div className="font-mono text-sm">#{e.epoch}</div>
                      <div className="small muted">{e.messageCount} message{e.messageCount===1?'':'s'}</div>
                    </div>
                    <span className={`pill ${e.state==='completed'?'bg-green-50 text-green-800': e.state==='failed'||e.state==='rejected'?'bg-amber-50 text-amber-800': e.state==='canceled'?'bg-gray-100 text-gray-800':'bg-gray-100 text-gray-800'}`}>{e.state}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Right: Transcript (wide) */}
          <div className="flex flex-col gap-3 order-2 lg:order-none">
            <div className="card">
              <div className="small muted mb-1.5">Transcript</div>
              {loadingSnap && <div className="small muted">Loading transcript…</div>}
              {!loadingSnap && !snap && <div className="small muted">Select a task from the list.</div>}
              {!loadingSnap && snap && (
                <div className="transcript faded" aria-live="polite">
                  {facts.map((f:any) => {
                    if (f.type === 'message_received' || f.type === 'message_sent') {
                      const isMe = f.type === 'message_sent'
                      const who = isMe ? 'Initiator' : 'Responder'
                      const ts = (f as any).ts;
                      const d = typeof ts === 'string' ? new Date(ts) : null;
                      const time = (d && !isNaN(d.getTime())) ? d.toLocaleTimeString() : '';
                      return (
                        <div key={f.id} className={'bubble ' + (isMe ? 'me' : 'them')}>
                          <div className="row items-center small muted mb-1">
                            <span className={`pill ${isMe ? 'bg-primary-100 text-primary-800' : 'bg-gray-100 text-gray-800'}`}>{who}</span>
                            <span className="muted">{time}</span>
                          </div>
                          <Markdown text={f.text} />
                          {Array.isArray(f.attachments) && f.attachments.length > 0 && (
                            <div className="attachments small">
                              {f.attachments.map((a:any) => {
                                const added = facts.find((x:any) => x.type === 'attachment_added' && (x as any).name === a.name)
                                const href = added && added.type === 'attachment_added' ? attachmentHrefFromBase64(a.name, (added as any).mimeType, (added as any).bytes) : null
                                return (
                                  <a key={a.name} className="att" href={href || '#'} target="_blank" rel="noreferrer" onClick={e => { if (!href) e.preventDefault(); }}>
                                    📎 {a.name} <span className="muted">({a.mimeType || 'application/octet-stream'})</span>
                                  </a>
                                )
                              })}
                            </div>
                          )}
                        </div>
                      )
                    }
                    return <div key={f.id} />
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </SharedAppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<HistoryApp />)
