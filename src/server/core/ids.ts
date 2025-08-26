export const initTaskId = (pairId:string, epoch:number) => `init:${pairId}#${epoch}`
export const respTaskId = (pairId:string, epoch:number) => `resp:${pairId}#${epoch}`

export function parseTaskId(id:string): { role:'init'|'resp'; pairId:string; epoch:number } {
  const [prefix, rest] = id.split(':')
  const [pairId, epochStr] = rest.split('#')
  const role = prefix === 'init' ? 'init' : 'resp'
  const epoch = Number(epochStr)
  return { role, pairId, epoch }
}

