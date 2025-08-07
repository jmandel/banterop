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
      getActiveBridgeAgent: async (conversationId: string): Promise<BridgeAgent | undefined> => {
        // Look up the bridged agent config
        const config = decodeConfigFromBase64URL(this.config64);
        const bridgedAgent = getBridgedAgent(config);
        if (!bridgedAgent) return undefined;
        
        try {
          const agent = await this.orchestrator.ensureAgentInstance(conversationId, bridgedAgent.id);
          return agent as BridgeAgent;
        } catch {
          return undefined;
        }
      },
      setTestTimeout: async (conversationId: string, timeout: number) => {
        const config = decodeConfigFromBase64URL(this.config64);
        const bridgedAgent = getBridgedAgent(config);
        if (!bridgedAgent) return;
        
        const agent = await this.orchestrator.ensureAgentInstance(conversationId, bridgedAgent.id);
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
        
        // Find the bridged agent in the config to validate it exists
        const bridgedAgent = getBridgedAgent(config);
        if (!bridgedAgent) {
          throw new Error('No bridged agent found in configuration');
        }
        
        // Validate that it's a bridge agent config
        if (bridgedAgent.strategyType !== 'bridge_to_external_mcp_server' && 
            bridgedAgent.strategyType !== 'bridge_to_external_mcp_client') {
          throw new Error('Invalid bridge agent strategy type');
        }
        
        // Create conversation
        const response = await this.createConversation(config);
        const conversationId = response.conversation.id;
        
        // Start the conversation - this will provision all server-managed agents
        // including the BridgeAgent and any scenario-driven agents
        await this.orchestrator.startConversation(conversationId);
        
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
      const startTime = Date.now();
      const timestamp = new Date().toISOString();
      const requestId = `mcp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      console.log(`[${timestamp}] [MCP send_message] START - requestId=${requestId}, conversationId=${params.conversationId}, message_length=${params.message?.length}`);
      
      try {
        const conversationId = params.conversationId;
        
        // Get the bridged agent ID from config
        const config = decodeConfigFromBase64URL(this.config64);
        const bridgedAgent = getBridgedAgent(config);
        if (!bridgedAgent) {
          throw new Error('No bridged agent found in configuration');
        }
        
        // Get the bridge agent instance via orchestrator
        const agent = await this.orchestrator.ensureAgentInstance(conversationId, bridgedAgent.id);
        if (!(agent instanceof BridgeAgent)) {
          throw new Error(`Agent ${bridgedAgent.id} is not a BridgeAgent`);
        }
        
        // Convert MCP attachments to AttachmentPayload format
        const attachments: AttachmentPayload[] | undefined = params.attachments?.map(att => ({
          name: att.name,
          contentType: att.contentType,
          content: att.content
        }));
        
        console.log(`[${new Date().toISOString()}] [MCP send_message] Awaiting bridge promise - requestId=${requestId}, timeout=180000ms (default)`);
        
        // Use BridgeAgent to bridge the external client's turn
        const reply = await agent.bridgeExternalClientTurn(
          params.message, 
          attachments
          // Use BridgeAgent's default timeout
        );
        
        const elapsed = Date.now() - startTime;
        console.log(`[${new Date().toISOString()}] [MCP send_message] SUCCESS - requestId=${requestId}, elapsed=${elapsed}ms`);
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(reply) 
          }]
        };
      } catch (error) {
        const elapsed = Date.now() - startTime;
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        console.log(`[${new Date().toISOString()}] [MCP send_message] ERROR - requestId=${requestId}, elapsed=${elapsed}ms, error="${errorMessage}"`);
        
        if (error instanceof Error && error.message.includes('Timeout')) {
          console.log(`[${new Date().toISOString()}] [MCP send_message] Returning timeout response - requestId=${requestId}`);
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ stillWorking: true, followUp: "Please call wait_for_reply until we have a response ready for you." }) 
            }]
          };
        }
        throw new Error(`Failed to send message: ${errorMessage}`);
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
        
        // Get the bridged agent ID from config
        const config = decodeConfigFromBase64URL(this.config64);
        const bridgedAgent = getBridgedAgent(config);
        if (!bridgedAgent) {
          throw new Error('No bridged agent found in configuration');
        }
        
        // Get the bridge agent instance via orchestrator
        const agent = await this.orchestrator.ensureAgentInstance(conversationId, bridgedAgent.id);
        if (!(agent instanceof BridgeAgent)) {
          throw new Error(`Agent ${bridgedAgent.id} is not a BridgeAgent`);
        }
        
        // Use BridgeAgent to wait for pending reply
        const reply = await agent.waitForPendingReply(); // Use BridgeAgent's default timeout
        
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
              text: JSON.stringify({ stillWorking: true, followUp: "Please continue to call wait_for_reply until we have a response ready for you." }) 
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
    
    // Create a new transport for this request (stateless mode)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
      enableJsonResponse: true // Prefer JSON responses over SSE
    });
    
    // Note: The response 'close' event is already handled by the bridge.ts route
    // We don't need to add another listener here
    
    try {
      // Connect the MCP server to the transport
      // The MCP server will handle all protocol methods internally
      // including initialize, tools/list, tools/call, etc.
      await this.mcpServer.connect(transport);
      
      // Let the transport handle the request
      // This delegates all MCP protocol handling to the SDK
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      // Error handling is done by the response adapter
      throw error;
    }
  }

  public async cleanup() {
    // Clean up any active bridge agents for this session
    // Note: In a stateless design, we don't track sessions, but we could
    // implement a cleanup based on conversation age or other criteria
    // For now, this is a no-op since bridge agents self-manage their lifecycle
  }
}