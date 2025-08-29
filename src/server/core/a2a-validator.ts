import Ajv from 'ajv'
import type { ValidateFunction } from 'ajv'
import { A2A_EXT_URL } from '../../shared/core'

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

// A2A Extension validation report type
type ValidationReport = {
  status: 'valid' | 'invalid'
  validatedAt: string // ISO 8601 timestamp
  validatedObjectType: string
  specificationUrl?: string
  errors: Array<{
    instancePath: string
    schemaPath: string
    keyword: string
    params: any
    message: string
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
    dataSample: JSON.stringify(data).slice(0, 500)
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

// Create validation report for metadata attachment
function createValidationReport(
  result: ValidationResult,
  objectType: string,
  specUrl?: string
): ValidationReport {
  return {
    status: result.valid ? 'valid' : 'invalid',
    validatedAt: new Date().toISOString(),
    validatedObjectType: objectType,
    specificationUrl: specUrl || 'https://github.com/a2aproject/A2A/blob/main/specification/json/a2a.json',
    errors: result.errors?.map(e => ({
      instancePath: e.path,
      schemaPath: '', // AJV doesn't provide this in our current setup
      keyword: e.keyword,
      params: e.params,
      message: e.message
    })) || []
  }
}

// Public validation functions
export function validateMessage(
  message: any,
  context?: { pairId?: string; messageId?: string }
): ValidationResult {
  return validateWithLogging(validators.message, message, 'Message', context)
}

export function validateMessageWithReport<T extends { metadata?: any }>(
  message: T,
  context?: { pairId?: string; messageId?: string }
): T {
  const result = validateWithLogging(validators.message, message, 'Message', context)
  const report = createValidationReport(result, 'Message')
  return withValidationReport(message, report)
}

export function validateTask(
  task: any,
  context?: { pairId?: string; taskId?: string }
): ValidationResult {
  return validateWithLogging(validators.task, task, 'Task', context)
}

export function validateTaskWithReport<T extends { metadata?: any }>(
  task: T,
  context?: { pairId?: string; taskId?: string; roomId?: string }
): T {
  const result = validateWithLogging(validators.task, task, 'Task', context)
  const report = createValidationReport(result, 'Task')
  return withValidationReport(task, report)
}

export function validateAgentCard(card: any, context?: { roomId?: string }): ValidationResult {
  return validateWithLogging(validators.agentCard, card, 'AgentCard', context)
}

export function validateAgentCardWithReport<T extends { metadata?: any }>(
  card: T,
  context?: { roomId?: string }
): T {
  const result = validateWithLogging(validators.agentCard, card, 'AgentCard', context)
  const report = createValidationReport(result, 'AgentCard')
  return withValidationReport(card, report)
}

export function validateTaskStatusUpdateEventWithReport<T extends { metadata?: any }>(
  event: T,
  context?: { pairId?: string; taskId?: string; roomId?: string }
): T {
  const result = validateWithLogging(validators.taskStatusUpdateEvent, event, 'TaskStatusUpdateEvent', context)
  const report = createValidationReport(result, 'TaskStatusUpdateEvent')
  return withValidationReport(event, report)
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


// Helper to create a new object with validation report attached
export function withValidationReport<T extends { metadata?: any }>(
  obj: T,
  report: ValidationReport
): T {
  return {
    ...obj,
    metadata: {
      ...obj.metadata,
      [A2A_EXT_URL]: {
        ...(obj.metadata?.[A2A_EXT_URL] || {}),
        validation: report
      }
    }
  }
}