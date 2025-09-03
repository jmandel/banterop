import type { Persistence, TaskRow, TaskState } from './persistence'
import { A2A_EXT_URL } from '../../shared/core'
import { utf8ToB64 } from '../../shared/codec'
import { extractNextState, computeStatesForNext } from './finality'
import { validateParts } from './validators'
import { initTaskId, respTaskId, parseTaskId } from './ids'
import { createEventStore } from './events'
import { validateMessageSendParams, validateMessage, validateTask, validateTaskStatusUpdateEvent, toA2AMessage, toA2ATask } from './a2a-validator'

type Deps = { db: Persistence; events: ReturnType<typeof createEventStore>; baseUrl: string }

export type TaskSnapshot = {
  id: string
  contextId: string
  kind: 'task'
  status: { state: TaskState; message?: any }
  history: any[]
}

export type PairsService = ReturnType<typeof createPairsService>

export function createPairsService({ db, events, baseUrl }: Deps) {
  const metadata = new Map<string, any>()
  // Single Active Backend (SAB) lease map
  const backendByRoom = new Map<string, { leaseId: string; connId: string; lastSeen: number; leaseGen: number }>()

  // Helper to create and validate TaskStatusUpdateEvent
  interface StatusUpdateParams {
    taskId: string
    pairId: string
    state: TaskState
    message?: any
    isFinal: boolean
  }
  
  function createStatusUpdateEvent(params: StatusUpdateParams) {
    const { taskId, pairId, state, message, isFinal } = params
    let statusUpdate = {
      kind: 'status-update' as const,
      taskId,
      contextId: taskId,
      status: {
        state,
        message
      },
      final: isFinal
    }
    // Validate (log-only)
    try { validateTaskStatusUpdateEvent(statusUpdate, { pairId, taskId, roomId: pairId }) } catch {}
    return statusUpdate
  }

  function hasActiveBackend(roomId: string): boolean {
    const l = backendByRoom.get(roomId)
    if (!l) return false
    return (Date.now() - l.lastSeen) < 45_000
  }

  function getLease(roomId: string): { leaseId: string; connId: string; leaseGen: number } | null {
    const l = backendByRoom.get(roomId)
    if (!l) return null
    return { leaseId: l.leaseId, connId: l.connId, leaseGen: l.leaseGen }
  }

  function rebindLease(roomId: string, leaseId: string, newConnId: string): boolean {
    const l = backendByRoom.get(roomId)
    if (!l) return false
    if (l.leaseId !== leaseId) return false
    backendByRoom.set(roomId, { ...l, connId: newConnId, lastSeen: Date.now() })
    return true
  }

  function acquireBackend(roomId: string, connId: string, takeover?: boolean): { granted: boolean; leaseId?: string; leaseGen?: number; takeover?: boolean } {
    const existing = backendByRoom.get(roomId)
    if (hasActiveBackend(roomId) && !takeover) return { granted: false }
    // If takeover, clear any existing lease first
    if (existing && takeover) {
      backendByRoom.delete(roomId)
    }
    const leaseId = crypto.randomUUID()
    const leaseGen = (existing?.leaseGen ?? 0) + 1
    backendByRoom.set(roomId, { leaseId, connId, lastSeen: Date.now(), leaseGen })
    return { granted: true, leaseId, leaseGen, takeover: !!existing }
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

  function toSnapshot(row: TaskRow, historyLength?: number, viewerLeaseId?: string | null): TaskSnapshot {
    const last = db.lastMessage(row.pair_id, row.epoch)
    const currentMsgId = last ? String((() => { try { return JSON.parse(last.json)?.messageId } catch { return '' } })() || '') : undefined
    const limit = typeof historyLength === 'number' ? sanitizeHistoryLength(historyLength) : 10_000
    const viewerTaskId = row.task_id
    const viewerRole: 'init'|'resp' = viewerTaskId.startsWith('init:') ? 'init' : 'resp'
    const rows = db.listMessages(row.pair_id, row.epoch, { order:'ASC', limit: Math.max(0, limit)+1 })
    const canonical = rows.map(r => ({ obj: (():any=>{ try { return JSON.parse(r.json) } catch { return {} } })(), author: r.author }))
      .filter(({obj}) => !currentMsgId || String(obj?.messageId || '') !== currentMsgId)
    const hist = canonical
      .slice(Math.max(0, canonical.length - limit))
      .map(({obj, author}) => projectForViewer(obj, viewerTaskId, viewerRole, author, viewerLeaseId))
      .filter(Boolean) as any[]
    // compute state for viewer
    let state: TaskState = 'submitted'
    let statusMessage: any = undefined
    if (last) {
      const obj = (()=>{ try { return JSON.parse(last.json) } catch { return {} } })()
      const desired = extractNextState(obj) ?? 'working'  // Default: turn-ending (it's your turn)
      const both = computeStatesForNext(last.author, desired)
      state = (viewerRole === 'init' ? (both as any).init : (both as any).resp) as TaskState
      statusMessage = projectForViewer(obj, viewerTaskId, viewerRole, last.author)
    }
    const snapshot: TaskSnapshot = { id: row.task_id, contextId: row.task_id, kind:'task', status:{ state, message: statusMessage }, history: hist }
    
    // Validate outbound task (log-only)
    try { validateTask(snapshot, { pairId: row.pair_id, taskId: row.task_id }) } catch {}

    return snapshot
  }

  function projectForViewer(message: any, viewerTaskId: string, viewerRole: 'init'|'resp', authorRoleHint?: 'init'|'resp', viewerLeaseId?: string | null) {
    try {
      const raw = typeof message === 'string' ? JSON.parse(message) : (message || {})
      // Drop relative fields from stored JSON
      const { role: _r, taskId: _t, contextId: _c, ...base } = raw
      // Audience scoping: filter out diagnostics when viewer is not intended audience
      try {
        const audience = String((raw as any)?.metadata?.server?.audience || '')
        if (audience && audience.startsWith('lease:')) {
          const want = audience.slice('lease:'.length)
          if (!viewerLeaseId || viewerLeaseId !== want) return null
        }
        if (audience && audience.startsWith('role:')) {
          const wantRole = audience.slice('role:'.length)
          if ((wantRole === 'init' && viewerRole !== 'init') || (wantRole === 'resp' && viewerRole !== 'resp')) return null
        }
      } catch {}
      const { pairId: viewerPairId } = parseTaskId(viewerTaskId)
      // Determine author role: prefer DB hint, fallback to parsing embedded sender taskId if present
      const senderTaskId: string = String(raw?.taskId || '')
      const parsedRole: 'init'|'resp' | null = senderTaskId.startsWith('init:') ? 'init' : (senderTaskId.startsWith('resp:') ? 'resp' : null)
      const authorRole: 'init'|'resp' = authorRoleHint ?? (parsedRole ?? viewerRole)
      const relRole = (authorRole === viewerRole) ? 'user' : 'agent'
      return { ...base, role: relRole, taskId: viewerTaskId, contextId: viewerTaskId }
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
    const desired = extractNextState(obj) ?? 'working'  // Default: turn-ending (it's your turn)
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

  // When sending without a taskId, begin a new epoch only if the current epoch already
  // has messages; otherwise reuse the current epoch (or create #1 if needed).
  function ensureEpochForSend(pairId: string): { epoch: number } {
    const p = db.getPair(pairId)
    if (!p) return ensureEpoch(pairId)
    if (p.epoch === 0) return ensureEpoch(pairId)
    const current = p.epoch
    const hasAnyInCurrent = !!db.lastMessage(pairId, current)
    if (!hasAnyInCurrent) return { epoch: current }
    const next = current + 1
    db.setPairEpoch(pairId, next)
    db.createEpochTasks(pairId, next)
    events.push(pairId, { type:'epoch-begin', epoch: next } as any)
    return { epoch: next }
  }

  async function upsertStates(pairId:string, epoch:number, states:{ init:TaskState; resp:TaskState }, sender:'init'|'resp', msg:any | undefined) {
    events.push(pairId, { type:'state', epoch, states: { initiator: states.init, responder: states.resp }, status: { message: msg && { ...msg } } } as any)
    // No longer emit A2A status-update client-wire-events here; limit wire log to new messages only
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

    getLease,
    rebindLease,

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
      const control = { messageId: crypto.randomUUID(), parts: [], kind:'message', taskId: id, contextId: pid, metadata: { [A2A_EXT_URL]: { nextState: 'canceled' } } }
      try {
        const { taskId: _t, contextId: _c, role: _r, ...persistBase } = control as any
        db.insertMessage({ pair_id: pid, epoch, author: role, json: JSON.stringify(persistBase) })
      } catch {}
      events.push(pairId, { type:'backchannel', action:'unsubscribe' } as any)
      events.push(pairId, { type:'state', epoch, states:{ initiator:'canceled', responder:'canceled' } } as any)
      return toSnapshot(db.getTask(initId)!)
    },

    async messageSend(pairId: string, m: any, configuration?: { historyLength?: number }, viewerLeaseId?: string | null) {
      // Validate MessageSendParams at the entry point (non-breaking)
      validateMessageSendParams({ message: m, configuration }, { pairId })
      
      const hasTaskId = !!m?.taskId
      const { epoch } = hasTaskId ? ensureEpoch(pairId) : ensureEpochForSend(pairId)

      const senderId = m?.taskId ?? initTaskId(pairId, epoch)
      const { role: senderRole } = parseTaskId(senderId)
      let msg = {
        role: m?.role ?? 'user',
        parts: m?.parts ?? [],
        messageId: m?.messageId ?? crypto.randomUUID(),
        taskId: senderId,
        contextId: pairId,
        kind: 'message',
        metadata: m?.metadata,
      }
      // Stop stamping wireMessage; client-wire-event will carry normalized payloads
      // Validate message (log-only)
      try { validateMessage(msg, { pairId, messageId: msg.messageId }) } catch {}
      
      // Existing parts validation (throws on errors)
      validateParts(msg.parts)

      const desired = extractNextState(msg) ?? 'working'  // Default: turn-ending (it's your turn)
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
        const absRoomsUrl = `${String(baseUrl || '').replace(/\/+$/, '')}/rooms/${pairId}`
        const errorMsg = {
          role: otherRole === 'init' ? 'user' : 'agent',
          parts: [{ kind:'text', text: `Room backend not open. Open ${absRoomsUrl} in a browser and keep that tab open. Processing runs in your browser.` }],
          messageId: `err:${crypto.randomUUID()}`,
          taskId: senderId, // relative for viewer; persisted JSON will strip these
          contextId: pairId,
          kind: 'message',
          metadata: { server: { category: 'room-error', reason: 'backend-not-open' }, [A2A_EXT_URL]: { nextState: 'failed' } }
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
        // Wire log: emit client-wire-event entries for the user-submitted message and server-authored error
        try {
          const initId = initTaskId(pairId, epoch);
          const projUser = projectForViewer(msg, initId, 'init', senderRole);
          const dirUser: 'inbound'|'outbound' = (String((projUser as any)?.role || '').toLowerCase() === 'user') ? 'inbound' : 'outbound';
          events.push(pairId, { type: 'client-wire-event', protocol:'a2a', dir: dirUser, method:'message/send', messageId: msg.messageId, payload: utf8ToB64(JSON.stringify(projUser)), epoch } as any);
        } catch {}
        try {
          const initId = initTaskId(pairId, epoch);
          const otherRole = senderRole === 'init' ? 'resp' : 'init';
          const projErr = projectForViewer(errorMsg, initId, 'init', otherRole);
          const dirErr: 'inbound'|'outbound' = (String((projErr as any)?.role || '').toLowerCase() === 'user') ? 'inbound' : 'outbound';
          events.push(pairId, { type: 'client-wire-event', protocol:'a2a', dir: dirErr, method:'message/send', messageId: errorMsg.messageId, payload: utf8ToB64(JSON.stringify(projErr)), epoch } as any);
        } catch {}
      const snapRow = db.getTask(senderId)!
      const limit = sanitizeHistoryLength(configuration?.historyLength)
      return toSnapshot(snapRow, limit)
      }

      // Lease-bound authorization for responder writes
      if (senderRole === 'resp') {
        const lease = getLease(pairId)
        const ok = !!(viewerLeaseId && lease && lease.leaseId === viewerLeaseId)
        if (!ok) {
          // Persist diagnostic scoped to offending lease (or none)
          const otherRole = 'init'
          const diag = {
            role: otherRole === 'init' ? 'user' : 'agent',
            parts: [{ kind:'text', text: 'Stale or missing backend lease. Your tab is no longer authorized to send. Refresh the room or take over.' }],
            messageId: `err:${crypto.randomUUID()}`,
            taskId: senderId,
            contextId: pairId,
            kind: 'message',
            metadata: { server: { category: 'room-error', reason: 'stale-backend-lease', audience: `lease:${viewerLeaseId || ''}` } }
          }
          try { const { role: _r3, taskId: _t3, contextId: _c3, ...pb3 } = diag as any; db.insertMessage({ pair_id: pairId, epoch, author: otherRole, json: JSON.stringify(pb3) }) } catch {}
          const snapRow = db.getTask(senderId)!
          const limit = sanitizeHistoryLength(configuration?.historyLength)
          return toSnapshot(snapRow, limit, viewerLeaseId)
        }
      }

      // Normal path: emit state then message
      await upsertStates(pairId, epoch, states, senderRole, msg)
      events.push(pairId, { type: 'message', epoch, messageId: msg.messageId, message: msg } as any)
      // Wire log: emit a client-wire-event for the new message (projected to initiator's perspective)
      try {
        const initId = initTaskId(pairId, epoch);
        const proj = projectForViewer(msg, initId, 'init', senderRole);
        const dir: 'inbound'|'outbound' = (String((proj as any)?.role || '').toLowerCase() === 'user') ? 'inbound' : 'outbound';
        const b64 = utf8ToB64(JSON.stringify(proj));
        events.push(pairId, { type: 'client-wire-event', protocol:'a2a', dir, method:'message/send', messageId: msg.messageId, payload: b64, epoch } as any);
      } catch {}
      const snapRow = db.getTask(senderId)!
      const limit = sanitizeHistoryLength(configuration?.historyLength)
      return toSnapshot(snapRow, limit)
    },

    messageStream(pairId: string, m?: any) {
      const self = this
      return (async function* () {
        const p = db.getPair(pairId)
        const currentEpoch = p && p.epoch > 0 ? p.epoch : 0
        const hasParts = !!(m && Array.isArray(m.parts) && m.parts.length > 0)
        const suppliedTaskId = String(m?.taskId || '') || undefined
        const viewerRole: 'init'|'resp' = suppliedTaskId ? parseTaskId(suppliedTaskId).role : 'init'

        // If no message or empty parts, just return current state
        if (!hasParts) {
          const impliedId = suppliedTaskId
            || (currentEpoch > 0 ? initTaskId(pairId, currentEpoch) : `init:${pairId}#1`)
          const snap = db.getTask(impliedId)!
          const currentState = snap ? toSnapshot(snap).status.state : 'submitted'
          const isTerminalFlag = isTerminal(currentState)
          const needsInput = currentState === 'input-required'
          
          const statusMessage = snap ? toSnapshot(snap).status.message : undefined
          yield createStatusUpdateEvent({
            taskId: impliedId,
            pairId,
            state: currentState,
            message: statusMessage,
            isFinal: isTerminalFlag || needsInput
          })
          return
        }

        // Send the message and get result
        const result = await self.messageSend(pairId, { ...(m||{}) }, m?.configuration)
        const effectiveId = String((result as any)?.id || (suppliedTaskId || (currentEpoch > 0 ? initTaskId(pairId, currentEpoch) : `init:${pairId}#1`)))
        const state = (result as any)?.status?.state || 'submitted'
        const message = (result as any)?.status?.message
        const isTerminalState = isTerminal(state)
        const needsInput = state === 'input-required'
        
        // Send TaskStatusUpdateEvent with all required fields
        yield createStatusUpdateEvent({
          taskId: effectiveId,
          pairId,
          state,
          message,
          isFinal: isTerminalState || needsInput
        })
      })()
    },

    tasksResubscribe(pairId: string, id: string) {
      const row = db.getTask(id)
      const { role: viewerRole } = parseTaskId(id)
      
      const stream = (async function* () {
        // Send initial status update
        const initialSnapshot: TaskSnapshot = row ? toSnapshot(row) : { id: id, contextId: pairId, kind:'task', status: { state: 'submitted' as TaskState }, history: [] }
        const initialState = initialSnapshot.status.state
        const isInitialTerminal = isTerminal(initialState)
        
        yield createStatusUpdateEvent({
          taskId: id,
          pairId,
          state: initialState,
          message: initialSnapshot.status.message,
          isFinal: isInitialTerminal
        })
        
        // If already terminal, don't continue streaming
        if (isInitialTerminal) {
          return
        }
        
        // Stream subsequent state changes
        for await (const ev of (events as any).stream(pairId, 0)) {
          const e = ev.result
          if (e.type === 'state') {
            const now = db.getTask(id)
            if (now) {
              const st = currentStateForEpoch(pairId, parseTaskId(id).epoch, viewerRole)
              const isTerminalState = isTerminal(st)
              
              yield createStatusUpdateEvent({
                taskId: id,
                pairId,
                state: st,
                message: e.status?.message,
                isFinal: isTerminalState
              })
              
              // Close stream only if terminal
              if (isTerminalState) {
                break
              }
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
    async beginNewEpochTasksForPair(pairId: string): Promise<{ initiatorTaskId: string; responderTaskId: string; epoch: number }> {
      const { epoch } = ensureEpochForSend(pairId)
      return { initiatorTaskId: initTaskId(pairId, epoch), responderTaskId: respTaskId(pairId, epoch), epoch }
    },
    // SAB helpers
    hasActiveBackend(roomId: string) { return hasActiveBackend(roomId) },
    acquireBackend(roomId: string, connId: string, takeover?: boolean) { return acquireBackend(roomId, connId, takeover) },
    renewBackend(roomId: string, connId: string) { return renewBackend(roomId, connId) },
    releaseBackend(roomId: string, connId: string) { return releaseBackend(roomId, connId) },
    getLeaseInfo(roomId: string) { return getLease(roomId) },
  }
}
