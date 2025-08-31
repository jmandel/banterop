// Minimal A2A JSON Schemas for browser-side validation in the Wire Log.
// These are intentionally permissive and focus on core fields we rely on.

export function getA2ASchema(kind: 'message'|'task'|'status-update'): any | null {
  if (kind === 'message') return MESSAGE_SCHEMA;
  if (kind === 'task') return TASK_SCHEMA;
  if (kind === 'status-update') return STATUS_UPDATE_SCHEMA;
  return null;
}

const ALLOWED_STATES = [
  'submitted','working','input-required','completed','canceled','failed','rejected','auth-required','unknown'
];

const TEXT_PART = {
  type: 'object',
  additionalProperties: true,
  properties: {
    kind: { const: 'text' },
    text: { type: 'string' },
  },
  required: ['kind','text']
};

const FILE_PART = {
  type: 'object',
  additionalProperties: true,
  properties: {
    kind: { const: 'file' },
    file: {
      type: 'object',
      additionalProperties: true,
      properties: {
        bytes: { type: 'string' },
        name: { type: 'string' },
        mimeType: { type: 'string' },
      },
      required: ['bytes','name','mimeType']
    }
  },
  required: ['kind','file']
};

const PART_SCHEMA = {
  oneOf: [ TEXT_PART, FILE_PART ]
};

const MESSAGE_SCHEMA = {
  $id: 'a2a.message',
  title: 'A2A Message',
  type: 'object',
  additionalProperties: true,
  properties: {
    role: { enum: ['user','agent'] },
    parts: { type: 'array', items: PART_SCHEMA },
    messageId: { type: 'string' },
    kind: { const: 'message' }
  },
  required: ['role','parts','messageId']
};

const STATUS_SCHEMA = {
  type: 'object',
  additionalProperties: true,
  properties: {
    state: { enum: ALLOWED_STATES },
    message: MESSAGE_SCHEMA,
    timestamp: { type: 'string' }
  },
  required: ['state']
};

const TASK_SCHEMA = {
  $id: 'a2a.task',
  title: 'A2A Task Snapshot',
  type: 'object',
  additionalProperties: true,
  properties: {
    kind: { const: 'task' },
    id: { type: 'string' },
    status: STATUS_SCHEMA,
    history: { type: 'array', items: MESSAGE_SCHEMA }
  },
  required: ['kind','id','status','history']
};

const STATUS_UPDATE_SCHEMA = {
  $id: 'a2a.status-update',
  title: 'A2A Task Status Update Event',
  type: 'object',
  additionalProperties: true,
  properties: {
    kind: { const: 'status-update' },
    status: STATUS_SCHEMA,
    final: { type: 'boolean' }
  },
  required: ['kind','status']
};

