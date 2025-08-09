// src/client/index.ts
//
// Client-side API exports

export { 
  ensureAgentsRunningClient, 
  autoResumeAgents,
  type ClientEnsureOptions,
  type ClientEnsureHandle
} from './ensure-agents';

export {
  createEventStream,
  sendMessage,
  getConversation,
  rpcCall,
  type EventStreamOptions
} from './client-api';