import type { Persistence, TaskRow, TaskState } from './persistence'
import { extractNextState, computeStatesForNext } from './finality'
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
  // Single Active Backend (SAB) lease map
  const backendByRoom = new Map<string, { leaseId: string; connId: string; lastSeen: number }>()

  function hasActiveBackend(roomId: string): boolean {
    const l = backendByRoom.get(roomId)
    if (!l) return false
    return (Date.now() - l.lastSeen) < 45_000
  }

  function acquireBackend(roomId: string, connId: string): { granted: boolean; leaseId?: string } {
    if (hasActiveBackend(roomId)) return { granted: false }
    const leaseId = crypto.randomUUID()
    backendByRoom.set(roomId, { leaseId, connId, lastSeen: Date.now() })
    return { granted: true, leaseId }
  }

  function renewBackend(roomId: string, connId: string): void {
    const l = backendByRoom.get(roomId)
    if (l && l.connId === connId) l.lastSeen = Date.now()
  }

  function releaseBackend(roomId: string, connId: string): void {
    const l = backendByRoom.get(roomId)
    if (l && l.connId === connId) backendByRoom.delete(roomId)
  }

  function sanitizeHistoryLength(v: unknown): number {
    const MAX = 10_000;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return MAX;
    if (n < 0) return 0;
    return Math.min(Math.floor(n), MAX);
  }

  function toSnapshot(row: TaskRow, historyLength?: number): TaskSnapshot {
    const last = db.lastMessage(row.pair_id, row.epoch)
    const currentMsgId = last ? String((() => { try { return JSON.parse(last.json)?.messageId } catch { return '' } })() || '') : undefined
    const limit = typeof historyLength === 'number' ? sanitizeHistoryLength(historyLength) : 10_000
    const viewerTaskId = row.task_id
    const viewerRole: 'init'|'resp' = viewerTaskId.startsWith('init:') ? 'init' : 'resp'
    const rows = db.listMessages(row.pair_id, row.epoch, { order:'ASC', limit: Math.max(0, limit)+1 })
    const canonical = rows.map(r => ({ obj: (():any=>{ try { return JSON.parse(r.json) } catch { return {} } })(), author: r.author }))
      .filter(({obj}) => !currentMsgId || String(obj?.messageId || '') !== currentMsgId)
    const hist = canonical.slice(Math.max(0, canonical.length - limit)).map(({obj, author}) => projectForViewer(obj, viewerTaskId, viewerRole, author))
    // compute state for viewer
    let state: TaskState = 'submitted'
    let statusMessage: any = undefined
    if (last) {
      const obj = (()=>{ try { return JSON.parse(last.json) } catch { return {} } })()
      const desired = extractNextState(obj) ?? 'input-required'
      const both = computeStatesForNext(last.author, desired)
      state = (viewerRole === 'init' ? (both as any).init : (both as any).resp) as TaskState
      statusMessage = projectForViewer(obj, viewerTaskId, viewerRole, last.author)
    }
    return { id: row.task_id, contextId: row.pair_id, kind:'task', status:{ state, message: statusMessage }, history: hist }
  }

  function projectForViewer(message: any, viewerTaskId: string, viewerRole: 'init'|'resp', authorRoleHint?: 'init'|'resp') {
    try {
      const raw = typeof message === 'string' ? JSON.parse(message) : (message || {})
      // Drop relative fields from stored JSON
      const { role: _r, taskId: _t, contextId: _c, ...base } = raw
      const { pairId: viewerPairId } = parseTaskId(viewerTaskId)
      // Determine author role: prefer DB hint, fallback to parsing embedded sender taskId if present
      const senderTaskId: string = String(raw?.taskId || '')
      const parsedRole: 'init'|'resp' | null = senderTaskId.startsWith('init:') ? 'init' : (senderTaskId.startsWith('resp:') ? 'resp' : null)
      const authorRole: 'init'|'resp' = authorRoleHint ?? (parsedRole ?? viewerRole)
      const relRole = (authorRole === viewerRole) ? 'user' : 'agent'
      return { ...base, role: relRole, taskId: viewerTaskId, contextId: viewerPairId }
    } catch {
      return message
    }
  }
  function currentStateForEpoch(pairId: string, epoch: number, viewerRole: 'init'|'resp'): TaskState { return currentStateForEpochFromDb(pairId, epoch, viewerRole) }

  function currentStateForEpochFromDb(pairId: string, epoch: number, viewerRole: 'init'|'resp'): TaskState {
    const last = db.lastMessage(pairId, epoch)
    if (!last) return 'submitted'
    let obj: any = {}
    try { obj = JSON.parse(last.json) } catch {}
    const desired = extractNextState(obj) ?? 'input-required'
    const both = computeStatesForNext(last.author, desired)
    return (viewerRole === 'init' ? (both as any).init : (both as any).resp) as TaskState
  }

  function ensureEpoch(pairId: string): { epoch: number } {
    const p = db.getPair(pairId)
    if (!p) {
      // Auto-create pair/epoch on first access for Rooms semantics
      try { db.createPair(pairId) } catch {}
      const epoch = 1
      db.setPairEpoch(pairId, epoch)
      db.createEpochTasks(pairId, epoch)
      events.push(pairId, { type:'epoch-begin', epoch } as any)
      return { epoch }
    }
    if (p.epoch === 0) {
      const epoch = 1
      db.setPairEpoch(pairId, epoch)
      db.createEpochTasks(pairId, epoch)
      events.push(pairId, { type:'epoch-begin', epoch } as any)
      return { epoch }
    }
    return { epoch: p.epoch }
  }

  function isTerminal(state: TaskState | undefined): boolean {
    return state === 'completed' || state === 'canceled' || (state as any) === 'failed' || (state as any) === 'rejected'
  }

  // NOTE: When sending without a taskId, we unconditionally bump to a new epoch.
  // This simplifies the demo server (no role/turn disambiguation here), but it will
  // fragment a single conversation across multiple epochs and can disrupt status/turn-taking.
  // Clients should preserve and include their taskId on every send to continue within
  // the current epoch. A production implementation would likely check whether the
  // current epoch is terminal before incrementing, or derive the correct sender taskId.
  function ensureEpochForSend(pairId: string): { epoch: number } {
    const p = db.getPair(pairId)
    if (!p) return ensureEpoch(pairId)
    if (p.epoch === 0) return ensureEpoch(pairId)
    const next = (p.epoch || 0) + 1
    db.setPairEpoch(pairId, next)
    db.createEpochTasks(pairId, next)
    events.push(pairId, { type:'epoch-begin', epoch: next } as any)
    return { epoch: next }
  }

  async function upsertStates(pairId:string, epoch:number, states:{ init:TaskState; resp:TaskState }, sender:'init'|'resp', msg:any | undefined) {
    events.push(pairId, { type:'state', epoch, states: { initiator: states.init, responder: states.resp }, status: { message: msg && { ...msg } } } as any)
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
      const { pairId: pid, epoch, role } = parseTaskId(id)
      const initId = initTaskId(pid, epoch)
      const respId = respTaskId(pid, epoch)
      if (!db.getTask(initId)) db.upsertTask({ task_id:initId, pair_id:pid, epoch })
      if (!db.getTask(respId)) db.upsertTask({ task_id:respId, pair_id:pid, epoch })
      // persist a control message with nextState=canceled so restart is deterministic
      const control = { messageId: crypto.randomUUID(), parts: [], kind:'message', taskId: id, contextId: pid, metadata: { 'https://chitchat.fhir.me/a2a-ext': { nextState: 'canceled' } } }
      try {
        const { taskId: _t, contextId: _c, role: _r, ...persistBase } = control as any
        db.insertMessage({ pair_id: pid, epoch, author: role, json: JSON.stringify(persistBase) })
      } catch {}
      events.push(pairId, { type:'backchannel', action:'unsubscribe' } as any)
      events.push(pairId, { type:'state', epoch, states:{ initiator:'canceled', responder:'canceled' } } as any)
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

      const desired = extractNextState(msg) ?? 'input-required'
      const states = computeStatesForNext(senderRole, desired)

      // Persist caller's attempted message first (idempotent by messageId)
      try {
        const { role: _r, taskId: _t, contextId: _c, ...persistBase } = msg as any
        db.insertMessage({ pair_id: pairId, epoch, author: senderRole, json: JSON.stringify(persistBase) })
      } catch (e: any) {
        const em = String(e?.message || '')
        if (!em.includes('UNIQUE')) throw e
      }

      // If no active backend, generate protocol error message and fail the task in-band
      if (!hasActiveBackend(pairId)) {
        const otherRole = senderRole === 'init' ? 'resp' : 'init'
        const errorMsg = {
          role: otherRole === 'init' ? 'user' : 'agent',
          parts: [{ kind:'text', text: `Room backend not open. Open /rooms/${pairId} in a browser and keep that tab open. Processing runs in your browser.` }],
          messageId: `err:${crypto.randomUUID()}`,
          taskId: senderId, // relative for viewer; persisted JSON will strip these
          contextId: pairId,
          kind: 'message',
          metadata: { server: { category: 'room-error', reason: 'backend-not-open' }, 'https://chitchat.fhir.me/a2a-ext': { nextState: 'failed' } }
        }
        // Persist server-authored error message as canonical latest
        try {
          const { role: _r2, taskId: _t2, contextId: _c2, ...persistBase2 } = errorMsg as any
          db.insertMessage({ pair_id: pairId, epoch, author: otherRole, json: JSON.stringify(persistBase2) })
        } catch {}
        // Persist FAILED states so snapshot reflects terminal state
        await upsertStates(pairId, epoch, { init:'failed', resp:'failed' } as any, senderRole, errorMsg)
        // Emit SSE events in consistent order: state → message(s)
        events.push(pairId, { type: 'state', epoch, states: { initiator:'failed', responder:'failed' }, status: { message: errorMsg } } as any)
        events.push(pairId, { type: 'message', epoch, messageId: msg.messageId, message: msg } as any)
        events.push(pairId, { type: 'message', epoch, messageId: errorMsg.messageId, message: errorMsg } as any)
        const snapRow = db.getTask(senderId)!
        const limit = sanitizeHistoryLength(configuration?.historyLength)
        return toSnapshot(snapRow, limit)
      }

      // Normal path: emit state then message
      await upsertStates(pairId, epoch, states, senderRole, msg)
      events.push(pairId, { type: 'message', epoch, messageId: msg.messageId, message: msg } as any)
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
        try {
          const st = (result as any)?.status?.state || 'submitted'
          yield { kind:'status-update', status:{ state: st } }
        } catch {}
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

      events.push(pairId, { type:'backchannel', action:'unsubscribe' } as any)
      events.push(pairId, { type:'state', epoch, states:{ initiator:'canceled', responder:'canceled' } } as any)

      if (type === 'hard') {
        events.push(pairId, { type:'reset-complete', epoch } as any)
        db.setPairEpoch(pairId, epoch + 1)
        db.createEpochTasks(pairId, epoch + 1)
      }
    },

    async ensureEpochTasksForPair(pairId: string): Promise<{ initiatorTaskId: string; responderTaskId: string; epoch: number }> {
      const { epoch } = ensureEpoch(pairId)
      return { initiatorTaskId: initTaskId(pairId, epoch), responderTaskId: respTaskId(pairId, epoch), epoch }
    },
    // SAB helpers
    hasActiveBackend(roomId: string) { return hasActiveBackend(roomId) },
    acquireBackend(roomId: string, connId: string) { return acquireBackend(roomId, connId) },
    renewBackend(roomId: string, connId: string) { return renewBackend(roomId, connId) },
    releaseBackend(roomId: string, connId: string) { return releaseBackend(roomId, connId) },
  }
}
