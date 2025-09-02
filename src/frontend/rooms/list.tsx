import React from 'react'
import { createRoot } from 'react-dom/client'
import { AppLayout } from '../ui'

type RoomRow = {
  roomId: string
  currentEpoch: number
  lastActivityTs: number | null
  state: string
  totalMessages: number
  messagesInWindow: number
  backendActive: boolean
}

type IndexResponse = { windowMs: number; total: number; rooms: RoomRow[] }
type OverviewResponse = { windowMs: number; counts: { roomsActive: number; messages: number; backendActive: number } }

function timeAgo(ts: number | null): string {
  if (!ts) return '—'
  const diff = Date.now() - ts
  if (diff < 60_000) return `${Math.max(0, Math.floor(diff/1000))}s`
  if (diff < 3600_000) return `${Math.floor(diff/60_000)}m`
  if (diff < 24*3600_000) return `${Math.floor(diff/3600_000)}h`
  return new Date(ts).toLocaleString()
}

function RoomsPage() {
  const base = new URL(window.location.href).origin
  const [windowSel, setWindowSel] = React.useState<'1h'|'24h'|'7d'>('24h')
  const [loading, setLoading] = React.useState(false)
  const [index, setIndex] = React.useState<IndexResponse | null>(null)
  const [overview, setOverview] = React.useState<OverviewResponse | null>(null)
  const [query, setQuery] = React.useState('')
  const [sort, setSort] = React.useState<'last'|'msgs'|'window'>('last')

  const winParam = windowSel === '1h' ? '1h' : (windowSel === '7d' ? String(7*24*3600_000) : '24h')

  async function load() {
    setLoading(true)
    try {
      const [o, i] = await Promise.all([
        fetch(`${base}/api/rooms/overview?window=${encodeURIComponent(winParam)}`).then(r=>r.json()),
        fetch(`${base}/api/rooms/index?window=${encodeURIComponent(winParam)}&sort=${encodeURIComponent(sort)}`).then(r=>r.json()),
      ])
      setOverview(o)
      setIndex(i)
    } catch {}
    setLoading(false)
  }

  React.useEffect(()=>{ load(); const t = setInterval(load, 15000); return ()=>clearInterval(t) }, [windowSel, sort])

  const rooms = (index?.rooms || []).filter(r => !query || r.roomId.includes(query))

  return (
    <AppLayout title="Banterop">
      {(() => (
        <div>
          {React.createElement(require('../ui/components/PageHeader').PageHeader as any, {
            title: (<span>Room Activity</span>),
            offset: 48,
            fullWidth: false,
          })}
        </div>
      ))()}
      <div className="container mx-auto p-4">
        {/* Consistent chips row */}
        <div className="card compact mb-4">
          <div className="row compact">
            <span className="pill bg-gray-100 text-gray-800">Rooms {overview?.counts?.roomsActive ?? '—'}</span>
            <span className="pill bg-gray-100 text-gray-800">Messages ({windowSel}) {overview?.counts?.messages ?? '—'}</span>
            <span className="pill bg-gray-100 text-gray-800">Backends Active {overview?.counts?.backendActive ?? '—'}</span>
            <div className="ml-auto row compact">
              <select value={windowSel} onChange={e=>setWindowSel(e.target.value as any)} className="border rounded px-2 py-1 text-sm">
                <option value="1h">Last 1h</option>
                <option value="24h">Last 24h</option>
                <option value="7d">Last 7d</option>
              </select>
              <input value={query} onChange={e=>setQuery(e.target.value)} placeholder="Search Room ID" className="border rounded px-2 py-1 text-sm" />
              <select value={sort} onChange={e=>setSort(e.target.value as any)} className="border rounded px-2 py-1 text-sm">
                <option value="last">Sort: Last Activity</option>
                <option value="msgs">Sort: Total Messages</option>
                <option value="window">Sort: Messages ({windowSel})</option>
              </select>
              <button onClick={load} className="border rounded px-3 py-1 text-sm">{loading ? 'Refreshing…' : 'Refresh'}</button>
            </div>
          </div>
        </div>

        <div className="row gap-2 mb-4 hidden">
          <div className="col">
            <div className="p-3 rounded border">
              <div className="text-xs text-muted">Rooms</div>
              <div className="text-2xl">{overview?.counts?.roomsActive ?? '—'}</div>
            </div>
          </div>
          <div className="col">
            <div className="p-3 rounded border">
              <div className="text-xs text-muted">Messages ({windowSel})</div>
              <div className="text-2xl">{overview?.counts?.messages ?? '—'}</div>
            </div>
          </div>
          <div className="col">
            <div className="p-3 rounded border">
              <div className="text-xs text-muted">Backends Active</div>
              <div className="text-2xl">{overview?.counts?.backendActive ?? '—'}</div>
            </div>
          </div>
          <div className="col ml-auto" />
        </div>

        <div className="overflow-auto border rounded">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left p-2">Room</th>
                <th className="text-left p-2">Epoch</th>
                <th className="text-left p-2">State</th>
                <th className="text-left p-2">Last Activity</th>
                <th className="text-left p-2">Msgs</th>
                <th className="text-left p-2">Msgs ({windowSel})</th>
                <th className="text-left p-2">Backend</th>
              </tr>
            </thead>
            <tbody>
              {rooms.map(r => (
                <tr key={r.roomId} className="border-t hover:bg-gray-50">
                  <td className="p-2">
                    <a href={`/rooms/${encodeURIComponent(r.roomId)}/history`} className="text-primary no-underline hover:underline">{r.roomId}</a>
                  </td>
                  <td className="p-2">{r.currentEpoch}</td>
                  <td className="p-2">{r.state}</td>
                  <td className="p-2">{timeAgo(r.lastActivityTs)}</td>
                  <td className="p-2">{r.totalMessages}</td>
                  <td className="p-2">{r.messagesInWindow}</td>
                  <td className="p-2">{r.backendActive ? <span className="text-green-600">active</span> : <span className="text-muted">—</span>}</td>
                </tr>
              ))}
              {!rooms.length && (
                <tr><td className="p-4 text-center text-muted" colSpan={7}>No rooms found.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </AppLayout>
  )
}

const root = createRoot(document.getElementById('root')!)
root.render(<RoomsPage />)
