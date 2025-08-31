import Ajv from 'ajv'
import type { ValidateFunction } from 'ajv'
// Note: stamping validation reports into metadata is no longer used.

// Import the A2A JSON schema directly
import a2aSchemaJson from '../../../a2a/specification/json/a2a.json'

// Type definitions matching A2A spec
type TaskState = 'submitted' | 'working' | 'input-required' | 'completed' | 'canceled' | 'failed' | 'rejected' | 'auth-required' | 'unknown'

const a2aSchema = a2aSchemaJson as any

// Initialize AJV with strict mode off for compatibility
const ajv = new Ajv({
  strict: false,
  allErrors: true,
  verbose: true
})

// Add the full schema with all definitions first
ajv.addSchema(a2aSchema, 'a2a')

// Compile validators for specific types using schema references
const validators = {
  message: ajv.compile({ $ref: 'a2a#/definitions/Message' }),
  task: ajv.compile({ $ref: 'a2a#/definitions/Task' }),
  agentCard: ajv.compile({ $ref: 'a2a#/definitions/AgentCard' }),
  part: ajv.compile({ $ref: 'a2a#/definitions/Part' }),
  messageSendParams: ajv.compile({ $ref: 'a2a#/definitions/MessageSendParams' }),
  taskStatusUpdateEvent: ajv.compile({ $ref: 'a2a#/definitions/TaskStatusUpdateEvent' })
}

// Validation result type
type ValidationResult = {
  valid: boolean
  errors?: Array<{
    path: string
    message: string
    keyword: string
    params: any
  }>
}


// Logger for validation errors (non-breaking)
function logValidationError(
  type: string,
  data: any,
  errors: any[],
  context?: { pairId?: string; taskId?: string; messageId?: string }
) {
  const timestamp = new Date().toISOString()
  const contextStr = context ? JSON.stringify(context) : ''
  const stack = (() => { try { return (new Error()).stack } catch { return undefined } })()

  console.warn(`[A2A Validation Warning] ${timestamp}`, {
    type,
    context: contextStr,
    errors: errors.map(e => ({
      path: e.instancePath || e.dataPath,
      message: e.message,
      keyword: e.keyword,
      params: e.params
    })),
    // Include a sample of the data for debugging (truncated for large objects)
    dataSample: JSON.stringify(data).slice(0, 500),
    stack
  })
}

// Non-breaking validation wrapper
function validateWithLogging<T>(
  validator: ValidateFunction,
  data: any,
  type: string,
  context?: any
): ValidationResult {
  const valid = validator(data)
  
  if (!valid && validator.errors) {
    logValidationError(type, data, validator.errors, context)
    return {
      valid: false,
      errors: validator.errors.map(e => ({
        path: e.instancePath || '',
        message: e.message || 'Unknown error',
        keyword: e.keyword,
        params: e.params
      }))
    }
  }
  
  return { valid: true }
}


// Public validation functions
export function validateMessage(
  message: any,
  context?: { pairId?: string; messageId?: string }
): ValidationResult {
  return validateWithLogging(validators.message, message, 'Message', context)
}

export function validateTask(
  task: any,
  context?: { pairId?: string; taskId?: string }
): ValidationResult {
  return validateWithLogging(validators.task, task, 'Task', context)
}

export function validateAgentCard(card: any, context?: { roomId?: string }): ValidationResult {
  return validateWithLogging(validators.agentCard, card, 'AgentCard', context)
}


// Log-only validation (no stamping)
export function validateTaskStatusUpdateEvent(
  event: any,
  context?: { pairId?: string; taskId?: string; roomId?: string }
): ValidationResult {
  return validateWithLogging(validators.taskStatusUpdateEvent, event, 'TaskStatusUpdateEvent', context)
}

export function validatePart(part: any, context?: any): ValidationResult {
  return validateWithLogging(validators.part, part, 'Part', context)
}

export function validateMessageSendParams(params: any, context?: any): ValidationResult {
  return validateWithLogging(validators.messageSendParams, params, 'MessageSendParams', context)
}

// Batch validation for message parts
export function validateMessageParts(
  parts: any[],
  context?: { pairId?: string; messageId?: string }
): ValidationResult {
  const errors: any[] = []
  
  for (let i = 0; i < parts.length; i++) {
    const result = validatePart(parts[i], { ...context, partIndex: i })
    if (!result.valid && result.errors) {
      errors.push(...result.errors.map(e => ({
        ...e,
        path: `parts[${i}]${e.path}`
      })))
    }
  }
  
  return errors.length > 0 
    ? { valid: false, errors }
    : { valid: true }
}

// Helper to transform internal types to A2A-compliant format
export function toA2AMessage(internal: any): any {
  return {
    role: internal.role === 'user' || internal.role === 'agent' ? internal.role : 'user',
    parts: internal.parts || [],
    messageId: internal.messageId,
    taskId: internal.taskId,
    contextId: internal.contextId,
    kind: 'message',
    metadata: internal.metadata
  }
}

export function toA2ATask(internal: any): any {
  return {
    id: internal.id,
    contextId: internal.contextId,
    kind: 'task',
    status: {
      state: mapToA2ATaskState(internal.status?.state),
      message: internal.status?.message,
      timestamp: new Date().toISOString()
    },
    history: internal.history || [],
    artifacts: internal.artifacts || [],
    metadata: internal.metadata
  }
}

function mapToA2ATaskState(state: string | undefined): TaskState {
  const validStates: TaskState[] = ['submitted', 'working', 'input-required', 'completed', 'canceled', 'failed', 'rejected', 'auth-required', 'unknown']
  return validStates.includes(state as TaskState) ? (state as TaskState) : 'unknown'
}


// Note: stamping validation reports into metadata has been removed.
