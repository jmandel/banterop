import React from 'react'
import { Markdown } from './Markdown'
import { attachmentHrefFromBase64 } from './attachments'
import { utf8ToB64 } from '../../shared/codec'

export function TraceView({ trace, showHeader = true, showRawLink = true }:{ trace: any; showHeader?: boolean; showRawLink?: boolean }) {
  const journal: any[] = Array.isArray(trace?.journal) ? trace.journal : []
  if (!journal.length) return null

  const pretty = (val: any) => { try { return JSON.stringify(val, null, 2) } catch { return String(val) } }

  function extractBlocks(obj: any): { cleaned: any; blocks: Array<{ contentType: string; content: string; label?: string }> } {
    const blocks: Array<{ contentType: string; content: string; label?: string }> = []
    function walk(v: any): any {
      if (!v || typeof v !== 'object') return v
      if (Array.isArray(v)) return v.map(walk)
      const ct = String((v as any)?.contentType || '')
      const cs = (v as any)?.contentString
      const c  = (v as any)?.content
      if (ct && typeof cs === 'string') {
        blocks.push({ contentType: ct, content: cs, label: String((v as any)?.name || '') })
        const { contentString: _c, ...rest } = v as any
        return { ...rest, contentString: '[rendered below]' }
      }
      if (ct && typeof c === 'string' && 'name' in (v as any)) {
        blocks.push({ contentType: ct, content: c, label: String((v as any)?.name || '') })
        const { content: _c2, ...rest2 } = v as any
        return { ...rest2, content: '[rendered below]' }
      }
      const out: any = Array.isArray(v) ? [] : { ...v }
      for (const k of Object.keys(out)) out[k] = walk(out[k])
      return out
    }
    const cleaned = walk(obj)
    return { cleaned, blocks }
  }

  function Entry({ e }: { e:any }) {
    const t = String(e?.type || '')
    const call = t === 'tool_call'
    const res  = t === 'tool_result'
    const err  = t === 'planner_error'
    const slp  = t === 'sleep'
    const q    = t === 'agent_question'
    const ua   = t === 'user_answer'
    const title = call ? `Tool Call: ${e?.name || ''}`
      : res ? `Tool Result${e?.ok===false?' (error)':''}`
      : err ? `Planner Error: ${e?.code || ''}`
      : slp ? `Sleep`
      : q ? `Agent Question`
      : ua ? `User Answer` : t
    const rawWhy = (typeof (e as any)?.why === 'string' && (e as any).why.trim()) ? (e as any).why : (typeof (e as any)?.reasoning === 'string' ? (e as any).reasoning : undefined);
    return (
      <div className="trace-entry border rounded p-2 mb-2 bg-gray-50 max-w-full overflow-hidden">
        { (call || res) && rawWhy && (
          <div className="small text-gray-700 mb-1 whitespace-pre-wrap break-words">
            <span className="muted">Reason: </span>{rawWhy}
          </div>
        )}
        <div className="small font-semibold text-gray-800">{title}</div>
        
        {call && (
          <div className="mt-1">
            <div className="small muted">args:</div>
            <pre className="code small whitespace-pre-wrap break-words max-w-full overflow-auto">{pretty(e?.args ?? {})}</pre>
          </div>
        )}
        {res && (
          <div className="mt-1">
            {e?.error && <div className="small text-red-700">{String(e.error)}</div>}
            {(() => {
              const r = e?.result
              if (typeof r === 'string' && r.trim().startsWith('#')) return <Markdown text={String(r)} />
              const { cleaned, blocks } = extractBlocks(r)
              return (
                <>
                  <pre className="code small whitespace-pre-wrap break-words max-w-full overflow-auto">{pretty(cleaned)}</pre>
                  {Array.isArray(blocks) && blocks.map((b,i)=>{
                    const isMd = /markdown/i.test(b.contentType)
                    const code = isMd ? b.content : `\`\`\`text\n${b.content}\n\`\`\``
                    return (
                      <div key={i} className="mt-2 max-w-full overflow-auto">
                        {b.label && <div className="small muted mb-1">{b.label}</div>}
                        <Markdown text={code} />
                      </div>
                    )
                  })}
                </>
              )
            })()}
          </div>
        )}
        {err && (
          <div className="mt-1">
            <div className="small text-red-700">{String(e?.message || '')}</div>
            {e?.detail && <pre className="code small whitespace-pre-wrap break-words max-w-full overflow-auto">{pretty(e.detail)}</pre>}
          </div>
        )}
        {slp && <div className="mt-1 small muted">{String(e?.reason || 'sleep')}</div>}
        {q && <div className="mt-1"><Markdown text={String(e?.prompt || '')} /></div>}
        {ua && <div className="mt-1"><Markdown text={String(e?.text || '')} /></div>}
      </div>
    )
  }

  const rawHref = React.useMemo(() => {
    if (!showRawLink) return null
    try { const b64 = utf8ToB64(JSON.stringify(trace, null, 2)); return attachmentHrefFromBase64('planner-trace.json','application/json', b64) } catch { return null }
  }, [trace, showRawLink])

  return (
    <div className="mt-2">
      {showHeader && (
        <div className="row items-center justify-between mb-1">
          <div className="small muted">Planner: {String(trace?.plannerType || 'off')}{trace?.plannerMode ? ` • ${String(trace.plannerMode)}` : ''}</div>
          {rawHref && <a className="small" href={rawHref} target="_blank" rel="noreferrer">Open raw JSON</a>}
        </div>
      )}
      <div>
        {journal.map((e:any, i:number) => <Entry key={String(e?.id||i)} e={e} />)}
      </div>
    </div>
  )
}
