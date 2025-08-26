export type Finality = 'none'|'turn'|'conversation'

export function extractFinality(msg:any): Finality {
  const top = msg?.metadata?.['https://chitchat.fhir.me/a2a-ext']
  if (top?.finality) return top.finality
  for (const p of msg?.parts ?? []) {
    const m = p?.metadata?.['https://chitchat.fhir.me/a2a-ext']
    if (m?.finality) return m.finality
  }
  return 'none'
}

export function computeStates(sender:'init'|'resp', finality:Finality) {
  let init:'submitted'|'working'|'input-required'|'completed'|'canceled' = 'working'
  let resp:'submitted'|'working'|'input-required'|'completed'|'canceled' = 'working'

  if (finality === 'conversation') {
    init = 'completed'; resp = 'completed'
  } else if (finality === 'turn') {
    // Hand off turn to the other side: sender working, receiver input-required
    if (sender === 'init') { init = 'working'; resp = 'input-required' }
    else { init = 'input-required'; resp = 'working' }
  } else { // 'none': sender input-required, other working
    if (sender === 'init') { init = 'input-required'; resp = 'working' }
    else { init = 'working'; resp = 'input-required' }
  }
  return { init, resp }
}
