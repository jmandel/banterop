import React from 'react'
import type { A2ANextState } from '../../shared/a2a-types'

const LABELS: Record<Extract<A2ANextState, 'working'|'input-required'|'completed'>, string> = {
  'input-required': "I'm still talking",
  'working': 'End my turn',
  'completed': 'End conversation',
}

export function NextStateSelect({ value, onChange, disabled, order }: {
  value: Extract<A2ANextState, 'working'|'input-required'|'completed'>
  onChange: (v: Extract<A2ANextState, 'working'|'input-required'|'completed'>) => void
  disabled?: boolean
  order?: Array<Extract<A2ANextState, 'working'|'input-required'|'completed'>>
}) {
  const opts = (order && order.length ? order : ['input-required','working','completed']) as Array<Extract<A2ANextState, 'working'|'input-required'|'completed'>>
  return (
    <select value={value} onChange={(e)=>onChange(e.target.value as any)} disabled={!!disabled} title="Next state">
      {opts.map(k => (
        <option key={k} value={k}>{LABELS[k]}</option>
      ))}
    </select>
  )
}
