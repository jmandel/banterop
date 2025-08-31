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

