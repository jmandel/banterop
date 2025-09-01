// Minimal JSON Schemas for MCP tool requests we emit from the browser client
// These schemas are for validation in the Wire Log (non-blocking diagnostics).

export function getMcpRequestSchema(method: string): any | null {
  const m = String(method || '').trim();
  if (!m) return null;
  if (m === 'begin_chat_thread') return MCP_BEGIN_CHAT_THREAD_REQ;
  if (m === 'send_message_to_chat_thread') return MCP_SEND_MESSAGE_REQ;
  if (m === 'check_replies') return MCP_CHECK_REPLIES_REQ;
  return null;
}

// Response schemas for MCP tools (validate parsed JSON returned by MCP content[0].text/json)
export function getMcpResponseSchema(method: string): any | null {
  const m = String(method || '').trim();
  if (!m) return null;
  if (m === 'begin_chat_thread') return MCP_BEGIN_CHAT_THREAD_RES;
  if (m === 'send_message_to_chat_thread') return MCP_SEND_MESSAGE_RES;
  if (m === 'check_replies') return MCP_CHECK_REPLIES_RES;
  return null;
}

const MCP_BEGIN_CHAT_THREAD_REQ = {
  $id: 'mcp.begin_chat_thread.request',
  title: 'MCP: begin_chat_thread (request)',
  type: 'object',
  additionalProperties: false,
  properties: {},
};

const AttachmentSchema = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', minLength: 1 },
    contentType: { type: 'string', minLength: 1 },
    content: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['name', 'contentType', 'content'],
};

const MCP_SEND_MESSAGE_REQ = {
  $id: 'mcp.send_message_to_chat_thread.request',
  title: 'MCP: send_message_to_chat_thread (request)',
  type: 'object',
  additionalProperties: false,
  properties: {
    conversationId: { type: 'string', minLength: 1 },
    message: { type: 'string' },
    attachments: { type: 'array', items: AttachmentSchema },
  },
  required: ['conversationId'],
};

const MCP_CHECK_REPLIES_REQ = {
  $id: 'mcp.check_replies.request',
  title: 'MCP: check_replies (request)',
  type: 'object',
  additionalProperties: false,
  properties: {
    conversationId: { type: 'string', minLength: 1 },
    waitMs: { type: 'number' },
  },
  required: ['conversationId'],
};

// --- Responses ---

const MCP_BEGIN_CHAT_THREAD_RES = {
  $id: 'mcp.begin_chat_thread.response',
  title: 'MCP: begin_chat_thread (response)',
  type: 'object',
  additionalProperties: true,
  properties: {
    conversationId: { type: 'string', minLength: 1 },
  },
  required: ['conversationId'],
};

const MCP_SEND_MESSAGE_RES = {
  $id: 'mcp.send_message_to_chat_thread.response',
  title: 'MCP: send_message_to_chat_thread (response)',
  type: 'object',
  additionalProperties: true,
  properties: {
    guidance: { type: 'string' },
    status: { type: 'string', enum: ['working'] },
  },
  required: ['guidance', 'status'],
};

const MCP_REPLY_ATTACHMENT = {
  type: 'object',
  additionalProperties: true,
  properties: {
    name: { type: 'string', minLength: 1 },
    contentType: { type: 'string', minLength: 1 },
    content: { type: 'string' },
    summary: { type: 'string' },
  },
  required: ['name', 'contentType', 'content'],
};

const MCP_REPLY_MESSAGE = {
  type: 'object',
  additionalProperties: true,
  properties: {
    from: { type: 'string', minLength: 1 },
    at: { type: 'string', minLength: 1 },
    text: { type: 'string' },
    attachments: { type: 'array', items: MCP_REPLY_ATTACHMENT },
  },
  required: ['from', 'at'],
};

const MCP_CHECK_REPLIES_RES = {
  $id: 'mcp.check_replies.response',
  title: 'MCP: check_replies (response)',
  type: 'object',
  additionalProperties: true,
  properties: {
    messages: { type: 'array', items: MCP_REPLY_MESSAGE },
    guidance: { type: 'string' },
    status: { type: 'string', enum: ['working','input-required','completed'] },
    conversation_ended: { type: 'boolean' },
  },
  required: ['messages', 'status'],
};
