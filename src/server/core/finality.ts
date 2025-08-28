import { A2A_EXT_URL, type NextState } from '../../shared/core'

function isNextState(v:any): v is NextState {
  return ['working','input-required','completed','canceled','failed','rejected','auth-required'].includes(String(v))
}

export function extractNextState(msg:any): NextState | null {
  const top = msg?.metadata?.[A2A_EXT_URL]
  if (isNextState(top?.nextState)) return top.nextState
  for (const p of msg?.parts ?? []) {
    const m = p?.metadata?.[A2A_EXT_URL]
    if (isNextState(m?.nextState)) return m.nextState
  }
  return null
}

export function computeStatesForNext(sender:'init'|'resp', next:NextState) {
  if (next === 'working') {
    return sender === 'init' ? { init:'working', resp:'input-required' } : { init:'input-required', resp:'working' }
  }
  if (next === 'input-required') {
    return sender === 'init' ? { init:'input-required', resp:'working' } : { init:'working', resp:'input-required' }
  }
  if (['completed','canceled','failed','rejected','auth-required'].includes(next)) {
    return { init: next as any, resp: next as any }
  }
  return sender === 'init' ? { init:'input-required', resp:'working' } : { init:'working', resp:'input-required' }
}
