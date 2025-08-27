import type { Persistence, TaskRow, TaskState } from './persistence'
import type { Finality } from './finality'
import { extractFinality, computeStates } from './finality'
import { validateParts } from './validators'
import { initTaskId, respTaskId, parseTaskId } from './ids'
import { createEventStore } from './events'

type Deps = { db: Persistence; events: ReturnType<typeof createEventStore>; baseUrl: string }

export type TaskSnapshot = {
  id: string
  contextId: string
  kind: 'task'
  status: { state: TaskState; message?: any }
  history: any[]
}

export type PairsService = ReturnType<typeof createPairsService>

export function createPairsService({ db, events }: Deps) {
  const metadata = new Map<string, any>()

  function sanitizeHistoryLength(v: unknown): number {
    const MAX = 10_000;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return MAX;
    if (n < 0) return 0;
    return Math.min(Math.floor(n), MAX);
  }

  function toSnapshot(row: TaskRow, historyLength?: number): TaskSnapshot {
    let currentMsgId: string | undefined = undefined
    try {
      const lastMsg = latestMessageForEpoch(row.pair_id, row.epoch)
      currentMsgId = lastMsg?.message?.messageId
    } catch {}
    const limit = typeof historyLength === 'number' ? sanitizeHistoryLength(historyLength) : 10_000
    // Build canonical history and project into the viewer's perspective
    const canonical = buildHistory(row.pair_id, row.epoch, currentMsgId, limit)
    const viewerTaskId = row.task_id
    const viewerRole: 'init'|'resp' = viewerTaskId.startsWith('init:') ? 'init' : 'resp'
    const hist = canonical.map((m:any) => projectForViewer(m, viewerTaskId, viewerRole))

    const state = currentStateForEpoch(row.pair_id, row.epoch, viewerRole)
    const statusMessage = currentMsgId ? projectForViewer(latestMessageForEpoch(row.pair_id, row.epoch)!.message, viewerTaskId, viewerRole) : undefined
    return {
      id: row.task_id,
      contextId: row.pair_id,
      kind: 'task',
      status: { state, message: statusMessage },
      history: hist,
    }
  }

  function buildHistory(pairId: string, epoch: number, excludeMessageId: string | undefined, limit: number): any[] {
    const msgs = events.listMessagesForEpoch(pairId, epoch)
    const out: any[] = []
    for (const m of msgs) {
      if (excludeMessageId && m.messageId === excludeMessageId) continue
      out.push(m.message)
    }
    if (limit <= 0) return []
    if (out.length <= limit) return out
    return out.slice(out.length - limit)
  }

  function projectForViewer(message: any, viewerTaskId: string, viewerRole: 'init'|'resp') {
    try {
      const m = typeof message === 'string' ? JSON.parse(message) : message
      // author role derived from sender taskId
      const senderTaskId: string = String(m?.taskId || '')
      const authorRole: 'init'|'resp' = senderTaskId.startsWith('init:') ? 'init' : 'resp'
      const role = (authorRole === viewerRole) ? 'user' : 'agent'
      return { ...m, role, taskId: viewerTaskId }
    } catch {
      return message
    }
  }
  function latestMessageForEpoch(pairId: string, epoch: number): { messageId: string; message: any } | null {
    const msgs = events.listMessagesForEpoch(pairId, epoch)
    if (!msgs.length) return null
    return msgs[msgs.length - 1]
  }
  function currentStateForEpoch(pairId: string, epoch: number, viewerRole: 'init'|'resp'): TaskState {
    const evs = (events as any).listSince(pairId, 0) as Array<any>
    let last: any = null
    for (const e of evs) {
      if (e.pairId === pairId && e.type === 'state' && typeof e.epoch === 'number' && e.epoch === epoch) last = e
    }
    if (last && last.states) {
      const st = viewerRole === 'init' ? last.states.initiator : last.states.responder
      return st as TaskState
    }
    return 'submitted'
  }

  function ensureEpoch(pairId: string): { epoch: number } {
    const p = db.getPair(pairId)
    if (!p) throw new Error('pair not found')
    if (p.epoch === 0) {
      const epoch = 1
      db.setPairEpoch(pairId, epoch)
      db.createEpochTasks(pairId, epoch)
      events.push(pairId, { type:'epoch-begin', epoch })
      return { epoch }
    }
    return { epoch: p.epoch }
  }

  function isTerminal(state: TaskState | undefined): boolean {
    return state === 'completed' || state === 'canceled' || (state as any) === 'failed' || (state as any) === 'rejected'
  }

  // When sending without taskId, start a new epoch if current tasks are terminal
  function ensureEpochForSend(pairId: string): { epoch: number } {
    const p = db.getPair(pairId)
    if (!p) throw new Error('pair not found')
    if (p.epoch === 0) return ensureEpoch(pairId)
    const next = (p.epoch || 0) + 1
    db.setPairEpoch(pairId, next)
    db.createEpochTasks(pairId, next)
    events.push(pairId, { type:'epoch-begin', epoch: next })
    return { epoch: next }
  }

  async function upsertStates(pairId:string, epoch:number, states:{ init:TaskState; resp:TaskState }, sender:'init'|'resp', msg:any | undefined) {
    events.push(pairId, { type:'state', epoch, states: { initiator: states.init, responder: states.resp }, status: { message: msg && { ...msg } } })
  }

  return {
    async createPair() {
      const pairId = crypto.randomUUID()
      db.createPair(pairId)
      events.push(pairId, { type:'pair-created' })
      return { pairId }
    },

    async getMetadata(pairId: string) {
      return metadata.get(pairId) ?? null
    },

    async tasksGet(pairId: string, id: string) {
      const row = db.getTask(id)
      if (row) return toSnapshot(row)
      const p = db.getPair(pairId)
      if (!p) throw new Error('pair not found')
      return {
        id,
        contextId: pairId,
        kind: 'task',
        status: { state: 'submitted' },
        history: [],
      }
    },

    async tasksCancel(pairId: string, id: string) {
      const { pairId: pid, epoch } = parseTaskId(id)
      const initId = initTaskId(pid, epoch)
      const respId = respTaskId(pid, epoch)
      if (!db.getTask(initId)) db.upsertTask({ task_id:initId, pair_id:pid, epoch })
      if (!db.getTask(respId)) db.upsertTask({ task_id:respId, pair_id:pid, epoch })
      events.push(pairId, { type:'backchannel', action:'unsubscribe' })
      events.push(pairId, { type:'state', epoch, states:{ initiator:'canceled', responder:'canceled' } })
      return toSnapshot(db.getTask(initId)!)
    },

    async messageSend(pairId: string, m: any, configuration?: { historyLength?: number }) {
      const hasTaskId = !!m?.taskId
      const { epoch } = hasTaskId ? ensureEpoch(pairId) : ensureEpochForSend(pairId)

      const senderId = m?.taskId ?? initTaskId(pairId, epoch)
      const { role: senderRole } = parseTaskId(senderId)
      const msg = {
        role: m?.role ?? 'user',
        parts: m?.parts ?? [],
        messageId: m?.messageId ?? crypto.randomUUID(),
        taskId: senderId,
        contextId: pairId,
        kind: 'message',
        metadata: m?.metadata,
      }

      validateParts(msg.parts)

      const f: Finality = extractFinality(msg)
      const states = computeStates(senderRole, f)

      await upsertStates(pairId, epoch, states, senderRole, msg)

      // Mirror message to the other side so their snapshot has status.message
      const otherRole = senderRole === 'init' ? 'resp' : 'init'
      const otherId = otherRole === 'init' ? initTaskId(pairId, epoch) : respTaskId(pairId, epoch)
      // mirrored status no longer persisted; snapshot uses events

      // Record canonical message event for history (by epoch)
      events.push(pairId, { type: 'message', epoch, messageId: msg.messageId, message: msg })

      const snapRow = db.getTask(senderId)!
      const limit = sanitizeHistoryLength(configuration?.historyLength)
      return toSnapshot(snapRow, limit)
    },

    messageStream(pairId: string, m?: any) {
      const self = this
      return (async function* () {
        const { epoch } = ensureEpoch(pairId)

        if (!m || (Array.isArray(m.parts) && m.parts.length === 0)) {
          const snap = db.getTask(initTaskId(pairId, epoch))!
          const limit = 10_000 // default when no configuration provided
          yield toSnapshot(snap, limit)
          return
        }

        const senderId = m.taskId ?? initTaskId(pairId, epoch)
        const result = await self.messageSend(pairId, { ...(m||{}), taskId: senderId }, m?.configuration)
        yield result
        yield { kind:'status-update', status:{ state: 'working' } }
      })()
    },

    tasksResubscribe(pairId: string, id: string) {
      const row = db.getTask(id)
      const initial = row ? toSnapshot(row) : { kind:'task', id, contextId: pairId, status:{ state:'submitted' }, history:[] }

      const stream = (async function* () {
        yield initial
        for await (const ev of (events as any).stream(pairId, 0)) {
          const e = ev.result
          if (e.type === 'state') {
            const now = db.getTask(id)
            if (now) {
              const role: 'init'|'resp' = id.startsWith('init:') ? 'init' : 'resp'
              const st = currentStateForEpoch(pairId, parseTaskId(id).epoch, role)
              yield { kind:'status-update', status: { state: st } }
            }
          }
        }
      })()
      return stream
    },

    async reset(pairId: string, type:'hard'|'soft') {
      const p = db.getPair(pairId)
      if (!p) return
      const epoch = p.epoch || 1

      const initId = initTaskId(pairId, epoch)
      const respId = respTaskId(pairId, epoch)

      if (!db.getTask(initId)) db.upsertTask({ task_id:initId, pair_id:pairId, epoch })
      if (!db.getTask(respId)) db.upsertTask({ task_id:respId, pair_id:pairId, epoch })

      events.push(pairId, { type:'backchannel', action:'unsubscribe' })
      events.push(pairId, { type:'state', epoch, states:{ initiator:'canceled', responder:'canceled' } })

      if (type === 'hard') {
        events.push(pairId, { type:'reset-complete', epoch })
        db.setPairEpoch(pairId, epoch + 1)
        db.createEpochTasks(pairId, epoch + 1)
      }
    },

    async ensureEpochTasksForPair(pairId: string): Promise<{ initiatorTaskId: string; responderTaskId: string; epoch: number }> {
      const { epoch } = ensureEpoch(pairId)
      return { initiatorTaskId: initTaskId(pairId, epoch), responderTaskId: respTaskId(pairId, epoch), epoch }
    },
  }
}
