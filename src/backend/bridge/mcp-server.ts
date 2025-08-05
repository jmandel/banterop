import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
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
        
        // Store the bridge agent for this conversation in the orchestrator's state
        const conversationState = (this.orchestrator as any).activeConversations.get(conversationId);
        if (conversationState) {
          if (!conversationState.agents) {
            conversationState.agents = new Map();
          }
          conversationState.agents.set(bridgedAgent.id, bridgeAgent);
        }
        
        // Store the bridge agent in our local map for quick access
        activeBridgeAgents.set(conversationId, bridgeAgent);
        
        // Use orchestrator's startConversation to initialize ALL agents
        // This will start all agents including scenario_driven ones
        console.log('[McpBridgeServer] Starting conversation through orchestrator');
        try {
          // Start all agents in the conversation
          await this.orchestrator.startConversation(conversationId);
          console.log('[McpBridgeServer] All agents started successfully');
        } catch (error) {
          console.error('[McpBridgeServer] Error starting conversation:', error);
          // If it fails because conversation already started, that's fine
          if (error instanceof Error && !error.message.includes('already been started')) {
            throw error;
          }
        }
        
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
          attachments
          // Use BridgeAgent's default timeout
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
        const reply = await bridgeAgent.waitForPendingReply(); // Use BridgeAgent's default timeout
        
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

  /**
   * Handle an HTTP request using the MCP server with StreamableHTTPServerTransport
   * This now works with our Hono-to-Node adapters
   */
  public async handleRequest(req: any, res: any, body: any): Promise<void> {
    console.log('[McpBridgeServer] handleRequest called');
    console.log('[McpBridgeServer] Request method:', req.method);
    console.log('[McpBridgeServer] Request headers:', req.headers);
    console.log('[McpBridgeServer] Request body:', body);
    
    // Create a new transport for this request (stateless mode)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
      enableJsonResponse: true // Prefer JSON responses over SSE
    });
    
    // Clean up transport when response closes
    res.on('close', () => {
      console.log('[McpBridgeServer] Response closed');
      transport.close();
    });
    
    try {
      // Connect the MCP server to the transport
      // The MCP server will handle all protocol methods internally
      // including initialize, tools/list, tools/call, etc.
      await this.mcpServer.connect(transport);
      
      // Let the transport handle the request
      // This delegates all MCP protocol handling to the SDK
      console.log('[McpBridgeServer] Calling transport.handleRequest');
      await transport.handleRequest(req, res, body);
      console.log('[McpBridgeServer] transport.handleRequest completed');
    } catch (error) {
      console.error('Error handling MCP request:', error);
      // Error handling is done by the response adapter
      throw error;
    }
  }
  
  /**
   * Alternative handler for direct Hono integration (without transport)
   * Kept for backwards compatibility or simpler use cases
   */
  public async handleRequestDirect(body: any): Promise<any> {
    const { method, params, id } = body;
    
    try {
      // Handle core MCP protocol methods
      switch (method) {
        case 'initialize':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              protocolVersion: '2024-11-05',
              capabilities: {
                tools: {}
              },
              serverInfo: {
                name: 'language-track-bridge',
                version: '1.0.0'
              }
            }
          };
          
        case 'tools/list':
          return {
            jsonrpc: '2.0',
            id,
            result: {
              tools: [
                {
                  name: 'begin_chat_thread',
                  description: 'Create a new conversation session for this MCP client',
                  inputSchema: {
                    type: 'object',
                    properties: {}
                  }
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
          
        case 'tools/call':
          // Handle tool calls
          const toolName = params.name;
          const toolArgs = params.arguments || {};
          
          let result;
          switch (toolName) {
            case 'begin_chat_thread':
              result = await this.handleBeginChatThread();
              break;
            case 'send_message_to_chat_thread':
              result = await this.handleSendMessage(toolArgs);
              break;
            case 'wait_for_reply':
              result = await this.handleWaitForReply(toolArgs);
              break;
            default:
              throw new Error(`Unknown tool: ${toolName}`);
          }
          
          return {
            jsonrpc: '2.0',
            id,
            result
          };
          
        default:
          throw new Error(`Unknown method: ${method}`);
      }
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
  
  // Remove duplicate methods - these are now only needed if using handleRequestDirect
  private async handleBeginChatThread(): Promise<any> {
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
      
      // Store the bridge agent in orchestrator's state
      const conversationState = (this.orchestrator as any).activeConversations.get(conversationId);
      if (conversationState) {
        if (!conversationState.agents) conversationState.agents = new Map();
        conversationState.agents.set(bridgedAgent.id, bridgeAgent);
      }
      
      // Store the bridge agent for this conversation
      activeBridgeAgents.set(conversationId, bridgeAgent);
      
      // Use orchestrator's startConversation to initialize ALL agents
      try {
        await this.orchestrator.startConversation(conversationId);
      } catch (error) {
        if (error instanceof Error && !error.message.includes('already been started')) {
          throw error;
        }
      }
      
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
  
  private async handleSendMessage(params: any): Promise<any> {
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
        attachments
        // Use BridgeAgent's default timeout
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
  
  private async handleWaitForReply(params: any): Promise<any> {
    try {
      const conversationId = params.conversationId;
      
      // Get the bridge agent for this conversation
      const bridgeAgent = activeBridgeAgents.get(conversationId);
      if (!bridgeAgent) {
        throw new Error('No active conversation. Call begin_chat_thread first.');
      }
      
      // Use BridgeAgent to wait for pending reply
      const reply = await bridgeAgent.waitForPendingReply(); // Use BridgeAgent's default timeout
      
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