import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { 
  CreateConversationRequest, 
  CreateConversationResponse,
  ConversationEvent,
  AttachmentPayload 
} from '$lib/types.js';
import { decodeConfigFromBase64URL } from '$lib/utils/config-encoding.js';
import { validateCreateConversationConfigV2, getBridgedAgent } from '$lib/utils/config-validation.js';
import { InProcessOrchestratorClient } from '$client/impl/in-process.client.js';
import { ConversationOrchestrator } from '../core/orchestrator.js';
import { BridgeAgent, BridgeReply } from '../../agents/bridge.agent.js';

// Tool schemas - define as raw shapes for MCP SDK
const beginChatThreadSchema = {};

const sendMessageSchema = {
  conversationId: z.string(),
  message: z.string(),
  attachments: z.array(z.object({
    name: z.string(),
    contentType: z.string(),
    content: z.string()
  })).optional()
};

const waitForReplySchema = {
  conversationId: z.string()
};

// Global map from conversation ID to BridgeAgent instance
const activeBridgeAgents = new Map<string, BridgeAgent>();

export class McpBridgeServer {
  private mcpServer: McpServer;
  
  constructor(
    private orchestrator: ConversationOrchestrator,
    private scenarioId: string,
    private config64: string,
    private sessionId: string
  ) {
    this.mcpServer = new McpServer({
      name: 'language-track-bridge',
      version: '1.0.0'
    });
    
    this.registerTools();
  }

  // Test helper object - only available in test environment
  get __test() {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error('Test helpers are only available in test environment');
    }
    
    return {
      activeBridgeAgents,
      getActiveBridgeAgent: (conversationId: string) => activeBridgeAgents.get(conversationId),
      clearActiveBridgeAgents: () => activeBridgeAgents.clear(),
      setTestTimeout: (conversationId: string, timeout: number) => {
        const agent = activeBridgeAgents.get(conversationId);
        if (agent) {
          (agent as any).__testTimeout = timeout;
        }
      }
    };
  }

  private registerTools() {
    // Tool: begin_chat_thread
    this.mcpServer.registerTool(
      'begin_chat_thread',
      {
        title: 'Begin Chat Thread',
        description: 'Create a new conversation session for this MCP client',
        inputSchema: beginChatThreadSchema
      },
      async () => {
      try {
        // Decode and validate config
        const config = decodeConfigFromBase64URL(this.config64);
        const validation = validateCreateConversationConfigV2(config);
        
        if (!validation.valid) {
          throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
        }
        
        // Create conversation
        const response = await this.createConversation(config);
        const conversationId = response.conversation.id;
        
        // Find the bridged agent in the config
        const bridgedAgent = getBridgedAgent(config);
        if (!bridgedAgent) {
          throw new Error('No bridged agent found in configuration');
        }
        
        // Validate that it's a bridge agent config
        if (bridgedAgent.strategyType !== 'bridge_to_external_mcp_server' && 
            bridgedAgent.strategyType !== 'bridge_to_external_mcp_client') {
          throw new Error('Invalid bridge agent strategy type');
        }
        
        // Get the agent token for the bridged agent
        const agentToken = response.agentTokens[bridgedAgent.id];
        
        // Create in-process client for the bridge agent
        const inProcessClient = new InProcessOrchestratorClient(this.orchestrator);
        
        // Create BridgeAgent instance with properly typed config
        const bridgeAgent = new BridgeAgent(bridgedAgent, inProcessClient);
        
        // Initialize the bridge agent
        await bridgeAgent.initialize(conversationId, agentToken);
        
        // Store the bridge agent for this conversation
        activeBridgeAgents.set(conversationId, bridgeAgent);
        
        // For MCP server mode, the external client is the initiator
        // The bridge agent will wait for external input before taking any action
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ conversationId }) 
          }]
        };
      } catch (error) {
        throw new Error(`Failed to begin chat thread: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });

    // Tool: send_message_to_chat_thread
    this.mcpServer.registerTool(
      'send_message_to_chat_thread',
      {
        title: 'Send Message to Chat Thread',
        description: 'Send a message to the conversation and wait for reply',
        inputSchema: sendMessageSchema
      },
      async (params) => {
      try {
        const conversationId = params.conversationId;
        
        // Get the bridge agent for this conversation
        const bridgeAgent = activeBridgeAgents.get(conversationId);
        if (!bridgeAgent) {
          throw new Error('No active conversation. Call begin_chat_thread first.');
        }
        
        // Convert MCP attachments to AttachmentPayload format
        const attachments: AttachmentPayload[] | undefined = params.attachments?.map(att => ({
          name: att.name,
          contentType: att.contentType,
          content: att.content
        }));
        
        // Use BridgeAgent to bridge the external client's turn
        const reply = await bridgeAgent.bridgeExternalClientTurn(
          params.message, 
          attachments,
          30000 // 30 second timeout
        );
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(reply) 
          }]
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Timeout')) {
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ timeout: true }) 
            }]
          };
        }
        throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });

    // Tool: wait_for_reply
    this.mcpServer.registerTool(
      'wait_for_reply',
      {
        title: 'Wait for Reply',
        description: 'Wait for the next reply from the other agent',
        inputSchema: waitForReplySchema
      },
      async (params) => {
      try {
        const conversationId = params.conversationId;
        
        // Get the bridge agent for this conversation
        const bridgeAgent = activeBridgeAgents.get(conversationId);
        if (!bridgeAgent) {
          throw new Error('No active conversation. Call begin_chat_thread first.');
        }
        
        // Use BridgeAgent to wait for pending reply
        const reply = await bridgeAgent.waitForPendingReply(60000); // 60 second timeout
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(reply) 
          }]
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Timeout')) {
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ timeout: true }) 
            }]
          };
        }
        throw new Error(`Failed to wait for reply: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    });
  }

  private async createConversation(config: CreateConversationRequest): Promise<CreateConversationResponse> {
    // Call orchestrator directly since we're in-process
    return await this.orchestrator.createConversation(config);
  }

  public getMcpServer(): McpServer {
    return this.mcpServer;
  }

  public async handleRequest(request: any): Promise<any> {
    // Handle JSON-RPC request
    const { method, params, id } = request;
    
    try {
      // Check if it's a tool call
      if (method === 'tools/call') {
        const toolName = params.name;
        const toolArgs = params.arguments || {};
        
        // Find the registered tool handler
        const toolHandlers = {
          'begin_chat_thread': this.handleBeginChatThread.bind(this),
          'send_message_to_chat_thread': this.handleSendMessage.bind(this),
          'wait_for_reply': this.handleWaitForReply.bind(this)
        };
        
        const handler = toolHandlers[toolName];
        if (!handler) {
          throw new Error(`Unknown tool: ${toolName}`);
        }
        
        const result = await handler(toolArgs);
        
        return {
          jsonrpc: '2.0',
          id,
          result
        };
      }
      
      // Handle other MCP methods (list tools, etc)
      if (method === 'tools/list') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            tools: [
              {
                name: 'begin_chat_thread',
                description: 'Create a new conversation session for this MCP client',
                inputSchema: {}
              },
              {
                name: 'send_message_to_chat_thread',
                description: 'Send a message to the conversation and wait for reply',
                inputSchema: {
                  type: 'object',
                  properties: {
                    conversationId: { type: 'string' },
                    message: { type: 'string' },
                    attachments: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          name: { type: 'string' },
                          contentType: { type: 'string' },
                          content: { type: 'string' }
                        }
                      }
                    }
                  },
                  required: ['conversationId', 'message']
                }
              },
              {
                name: 'wait_for_reply',
                description: 'Wait for the next reply from the other agent',
                inputSchema: {
                  type: 'object',
                  properties: {
                    conversationId: { type: 'string' }
                  },
                  required: ['conversationId']
                }
              }
            ]
          }
        };
      }
      
      throw new Error(`Unknown method: ${method}`);
    } catch (error) {
      return {
        jsonrpc: '2.0',
        id,
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Internal error'
        }
      };
    }
  }

  private async handleBeginChatThread(params: any) {
    // Reuse the logic from the registered tool handler
    try {
      // Decode and validate config
      const config = decodeConfigFromBase64URL(this.config64);
      const validation = validateCreateConversationConfigV2(config);
      
      if (!validation.valid) {
        throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
      }
      
      // Create conversation
      const response = await this.createConversation(config);
      const conversationId = response.conversation.id;
      
      // Find the bridged agent in the config
      const bridgedAgent = getBridgedAgent(config);
      if (!bridgedAgent) {
        throw new Error('No bridged agent found in configuration');
      }
      
      // Validate that it's a bridge agent config
      if (bridgedAgent.strategyType !== 'bridge_to_external_mcp_server' && 
          bridgedAgent.strategyType !== 'bridge_to_external_mcp_client') {
        throw new Error('Invalid bridge agent strategy type');
      }
      
      // Get the agent token for the bridged agent
      const agentToken = response.agentTokens[bridgedAgent.id];
      
      // Create in-process client for the bridge agent
      const inProcessClient = new InProcessOrchestratorClient(this.orchestrator);
      
      // Create BridgeAgent instance with properly typed config
      const bridgeAgent = new BridgeAgent(bridgedAgent, inProcessClient);
      
      // Initialize the bridge agent
      await bridgeAgent.initialize(conversationId, agentToken);
      
      // Store the bridge agent for this conversation
      activeBridgeAgents.set(conversationId, bridgeAgent);
      
      // For MCP server mode, the external client is the initiator
      // The bridge agent will wait for external input before taking any action
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify({ conversationId }) 
        }]
      };
    } catch (error) {
      throw new Error(`Failed to begin chat thread: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleSendMessage(params: any) {
    try {
      const conversationId = params.conversationId;
      
      // Get the bridge agent for this conversation
      const bridgeAgent = activeBridgeAgents.get(conversationId);
      if (!bridgeAgent) {
        throw new Error('No active conversation. Call begin_chat_thread first.');
      }
      
      // Convert MCP attachments to AttachmentPayload format
      const attachments: AttachmentPayload[] | undefined = params.attachments?.map((att: any) => ({
        name: att.name,
        contentType: att.contentType,
        content: att.content
      }));
      
      // Use BridgeAgent to bridge the external client's turn
      const reply = await bridgeAgent.bridgeExternalClientTurn(
        params.message, 
        attachments,
        30000 // 30 second timeout
      );
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify(reply) 
        }]
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Timeout')) {
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ timeout: true }) 
          }]
        };
      }
      throw new Error(`Failed to send message: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  private async handleWaitForReply(params: any) {
    try {
      const conversationId = params.conversationId;
      
      // Get the bridge agent for this conversation
      const bridgeAgent = activeBridgeAgents.get(conversationId);
      if (!bridgeAgent) {
        throw new Error('No active conversation. Call begin_chat_thread first.');
      }
      
      // Use BridgeAgent to wait for pending reply
      const reply = await bridgeAgent.waitForPendingReply(60000); // 60 second timeout
      
      return {
        content: [{ 
          type: 'text', 
          text: JSON.stringify(reply) 
        }]
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Timeout')) {
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify({ timeout: true }) 
          }]
        };
      }
      throw new Error(`Failed to wait for reply: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  public async cleanup() {
    // Clean up any active bridge agents for this session
    // Note: In a stateless design, we don't track sessions, but we could
    // implement a cleanup based on conversation age or other criteria
    // For now, this is a no-op since bridge agents self-manage their lifecycle
  }
}