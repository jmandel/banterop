import type { Persistence, TaskRow, TaskState } from './persistence'
import type { Finality } from './finality'
import { extractFinality, computeStates } from './finality'
import { validateParts } from './validators'
import { initTaskId, respTaskId, parseTaskId } from './ids'

type Deps = { db: Persistence; events: { push: Function; stream: Function }; baseUrl: string }

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

  function toSnapshot(row: TaskRow): TaskSnapshot {
    return {
      id: row.task_id,
      contextId: row.pair_id,
      kind: 'task',
      status: { state: row.state as TaskState, message: row.message ? JSON.parse(row.message) : undefined },
      history: [],
    }
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

  async function upsertStates(pairId:string, epoch:number, states:{ init:TaskState; resp:TaskState }, sender:'init'|'resp', msg:any | undefined) {
    const initId = initTaskId(pairId, epoch)
    const respId = respTaskId(pairId, epoch)

    const initRow = db.getTask(initId)!
    const respRow = db.getTask(respId)!

    const set = (row: TaskRow, next: TaskState, maybeMsg?: any) => {
      db.upsertTask({
        ...row,
        state: next,
        message: maybeMsg ? JSON.stringify(maybeMsg) : (row.message ?? null),
      })
    }

    if (sender === 'init') {
      set(initRow, states.init, msg)
      set(respRow, states.resp)
    } else {
      set(respRow, states.resp, msg)
      set(initRow, states.init)
    }

    events.push(pairId, {
      type:'state',
      states: { initiator: states.init, responder: states.resp },
      status: { message: msg && { ...msg } }
    })
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

      const initRow = db.getTask(initId) ?? { task_id:initId, pair_id:pid, role:'init' as const, epoch, state:'submitted' as TaskState, message:null }
      const respRow = db.getTask(respId) ?? { task_id:respId, pair_id:pid, role:'resp' as const, epoch, state:'submitted' as TaskState, message:null }

      db.upsertTask({ ...initRow, state:'canceled' })
      db.upsertTask({ ...respRow, state:'canceled' })

      events.push(pairId, { type:'backchannel', action:'unsubscribe' })
      events.push(pairId, { type:'state', states:{ initiator:'canceled', responder:'canceled' } })

      return toSnapshot(db.getTask(initId)!)
    },

    async messageSend(pairId: string, m: any, configuration?: { historyLength?: number }) {
      const { epoch } = ensureEpoch(pairId)

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
      try {
        const mirrored = {
          role: 'agent',
          parts: (msg.parts ?? []).map((p:any) => p && p.kind === 'text' ? { kind:'text', text: p.text } : p),
          messageId: crypto.randomUUID(),
          taskId: otherId,
          contextId: pairId,
          kind: 'message',
          metadata: msg.metadata,
        }
        const otherRow = db.getTask(otherId)
        if (otherRow) db.upsertTask({ ...otherRow, message: JSON.stringify(mirrored) })
      } catch {}

      const snapRow = db.getTask(senderId)!
      return { kind:'task', ...toSnapshot(snapRow) }
    },

    messageStream(pairId: string, m?: any) {
      const self = this
      return (async function* () {
        const { epoch } = ensureEpoch(pairId)

        if (!m || (Array.isArray(m.parts) && m.parts.length === 0)) {
          const snap = db.getTask(initTaskId(pairId, epoch))!
          yield { kind:'task', ...toSnapshot(snap) }
          return
        }

        const senderId = m.taskId ?? initTaskId(pairId, epoch)
        const senderRole = parseTaskId(senderId).role

        const result = await self.messageSend(pairId, m, m?.configuration)
        yield result

        const otherRole = senderRole === 'init' ? 'resp' : 'init'
        const otherId = otherRole === 'init' ? initTaskId(pairId, epoch) : respTaskId(pairId, epoch)

        const orig = m
        const mirrored = {
          role: 'agent',
          parts: (orig.parts ?? []).map((p:any) => p && p.kind === 'text' ? { kind:'text', text: p.text } : p),
          messageId: crypto.randomUUID(),
          taskId: otherId,
          contextId: pairId,
          kind: 'message',
          metadata: orig.metadata,
        }

        const row = db.getTask(otherId)!
        db.upsertTask({ ...row, message: JSON.stringify(mirrored) })

        yield { kind:'status-update', status:{ state: 'working' } }
      })()
    },

    tasksResubscribe(pairId: string, id: string) {
      const row = db.getTask(id)
      const initial = row ? { kind:'task', ...toSnapshot(row) } : { kind:'task', id, contextId: pairId, status:{ state:'submitted' }, history:[] }

      const stream = (async function* () {
        yield initial
        for await (const ev of (events as any).stream(pairId, 0)) {
          const e = ev.result
          if (e.type === 'state') {
            const now = db.getTask(id)
            if (now) yield { kind:'status-update', status: { state: now.state } }
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

      const initRow = db.getTask(initId) ?? { task_id:initId, pair_id:pairId, role:'init' as const, epoch, state:'submitted' as TaskState, message:null }
      const respRow = db.getTask(respId) ?? { task_id:respId, pair_id:pairId, role:'resp' as const, epoch, state:'submitted' as TaskState, message:null }
      db.upsertTask({ ...initRow, state:'canceled' })
      db.upsertTask({ ...respRow, state:'canceled' })

      events.push(pairId, { type:'backchannel', action:'unsubscribe' })
      events.push(pairId, { type:'state', states:{ initiator:'canceled', responder:'canceled' } })

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
