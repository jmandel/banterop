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
import { BridgeAgent, BridgeReply, BridgeContext } from '../../agents/bridge.agent.js';

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
    // Note: We no longer register tools here - they're registered per-request
    // with dynamic descriptions based on the scenario context
    this.mcpServer = new McpServer({
      name: 'language-track-bridge',
      version: '1.0.0'
    });
  }

  private getTimeoutMs(): number {
    return this.orchestrator.getConfig().bridgeReplyTimeoutMs;
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

  private async beginChatThreadHandler() {
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
        console.log(`[MCP Bridge] Starting conversation ${conversationId}, this should provision bridge agent ${bridgedAgent.id}`);
        await this.orchestrator.startConversation(conversationId);
        
        // Verify the bridge agent was created
        const bridgeAgentInstance = this.orchestrator.getAgentInstance(conversationId, bridgedAgent.id);
        console.log(`[MCP Bridge] Bridge agent instance after start: ${bridgeAgentInstance ? 'EXISTS' : 'NOT FOUND'}, type: ${bridgeAgentInstance?.constructor.name}`);
        
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

  private async sendMessageHandler(params: any) {
      const startTime = Date.now();
      const timestamp = new Date().toISOString();
      const requestId = `mcp_${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      console.log(`[${timestamp}] [MCP send_message] START - requestId=${requestId}, conversationId=${params.conversationId}, message_length=${params.message?.length}`);
      
      // Get the bridged agent ID from config (outside try for error handler access)
      const config = decodeConfigFromBase64URL(this.config64);
      const bridgedAgent = getBridgedAgent(config);
      let agent: BridgeAgent | undefined;
      
      try {
        const conversationId = params.conversationId;
        
        if (!bridgedAgent) {
          throw new Error('No bridged agent found in configuration');
        }
        
        // Get the bridge agent instance via orchestrator
        const agentInstance = await this.orchestrator.ensureAgentInstance(conversationId, bridgedAgent.id);
        if (!(agentInstance instanceof BridgeAgent)) {
          throw new Error(`Agent ${bridgedAgent.id} is not a BridgeAgent`);
        }
        agent = agentInstance;
        
        // Convert MCP attachments to AttachmentPayload format
        const attachments: AttachmentPayload[] | undefined = params.attachments?.map(att => ({
          name: att.name,
          contentType: att.contentType,
          content: att.content
        }));
        
        const timeoutMs = this.getTimeoutMs();
        console.log(`[${new Date().toISOString()}] [MCP send_message] Awaiting bridge promise - requestId=${requestId}, timeout=${timeoutMs}ms`);
        
        // Use BridgeAgent to bridge the external client's turn with orchestrator timeout
        const reply = await agent.bridgeExternalClientTurn(
          params.message, 
          attachments,
          timeoutMs
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
          
          // Get stats from the bridge agent (if we have it)
          const stats = agent ? agent.getOtherAgentStats() : { otherAgentActions: 0 };
          
          // Get the counterparty details from config for better messaging
          const scenarioItem = this.orchestrator.getDbInstance().findScenarioById(config.metadata?.scenarioId || '');
          const scenarioConfig = scenarioItem?.config;
          const counterpartyAgent = scenarioConfig?.agents?.find((a: any) => a.agentId !== bridgedAgent?.id);
          const counterpartyName = counterpartyAgent?.principal?.name || 'The other agent';
          const counterpartyId = counterpartyAgent?.agentId || 'unknown';
          const counterpartyDesc = counterpartyAgent?.principal?.description || '';
          
          let actionMessage: string;
          if (stats.otherAgentActions > 0) {
            actionMessage = `${counterpartyName} (${counterpartyId}) has taken ${stats.otherAgentActions} action${stats.otherAgentActions !== 1 ? 's' : ''} so far.`;
            if (counterpartyDesc) {
              actionMessage += ` ${counterpartyDesc}`;
            }
          } else {
            actionMessage = `${counterpartyName} (${counterpartyId}) is processing your message.`;
          }
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ 
                stillWorking: true, 
                followUp: "Please call wait_for_reply until we have a response ready for you.",
                status: {
                  message: actionMessage,
                  actionCount: stats.otherAgentActions,
                  lastActionAt: stats.lastActionAt,
                  lastActionType: stats.lastActionType
                }
              }) 
            }]
          };
        }
        throw new Error(`Failed to send message: ${errorMessage}`);
      }
    }

  private async waitForReplyHandler(params: any) {
      // Get the bridged agent ID from config (outside try for error handler access)
      const config = decodeConfigFromBase64URL(this.config64);
      const bridgedAgent = getBridgedAgent(config);
      
      try {
        const conversationId = params.conversationId;
        
        if (!bridgedAgent) {
          throw new Error('No bridged agent found in configuration');
        }
        
        // Get the bridge agent instance via orchestrator
        const agent = await this.orchestrator.ensureAgentInstance(conversationId, bridgedAgent.id);
        if (!(agent instanceof BridgeAgent)) {
          throw new Error(`Agent ${bridgedAgent.id} is not a BridgeAgent`);
        }
        
        // Use BridgeAgent to wait for pending reply with orchestrator timeout
        const timeoutMs = this.getTimeoutMs();
        const reply = await agent.waitForPendingReply(timeoutMs);
        
        return {
          content: [{ 
            type: 'text', 
            text: JSON.stringify(reply) 
          }]
        };
      } catch (error) {
        if (error instanceof Error && error.message.includes('Timeout')) {
          // Get the bridge agent to query stats
          const bridgeAgentInstance = await this.orchestrator.ensureAgentInstance(params.conversationId, bridgedAgent!.id);
          const stats = (bridgeAgentInstance as BridgeAgent).getOtherAgentStats();
          
          // Get the counterparty details from config for better messaging
          const scenarioItem = this.orchestrator.getDbInstance().findScenarioById(config.metadata?.scenarioId || '');
          const scenarioConfig = scenarioItem?.config;
          const counterpartyAgent = scenarioConfig?.agents?.find((a: any) => a.agentId !== bridgedAgent?.id);
          const counterpartyName = counterpartyAgent?.principal?.name || 'The other agent';
          const counterpartyId = counterpartyAgent?.agentId || 'unknown';
          const counterpartyDesc = counterpartyAgent?.principal?.description || '';
          
          let actionMessage: string;
          if (stats.otherAgentActions > 0) {
            actionMessage = `${counterpartyName} (${counterpartyId}) has taken ${stats.otherAgentActions} action${stats.otherAgentActions !== 1 ? 's' : ''} so far.`;
            if (counterpartyDesc) {
              actionMessage += ` ${counterpartyDesc}`;
            }
          } else {
            actionMessage = `${counterpartyName} (${counterpartyId}) is still working on a response.`;
          }
          
          return {
            content: [{ 
              type: 'text', 
              text: JSON.stringify({ 
                stillWorking: true, 
                followUp: "Please continue to call wait_for_reply until we have a response ready for you.",
                status: {
                  message: actionMessage,
                  actionCount: stats.otherAgentActions,
                  lastActionAt: stats.lastActionAt,
                  lastActionType: stats.lastActionType
                }
              }) 
            }]
          };
        }
        throw new Error(`Failed to wait for reply: ${error instanceof Error ? error.message : 'Unknown error'}`);
      }
    }

  private async createConversation(config: CreateConversationRequest): Promise<CreateConversationResponse> {
    // Call orchestrator directly since we're in-process
    return await this.orchestrator.createConversation(config);
  }

  public getMcpServer(): McpServer {
    return this.mcpServer;
  }

  /**
   * Build a new MCP server with context-aware tool descriptions
   */
  private async buildServerWithContext(bridgeCtx: BridgeContext): Promise<McpServer> {
    const server = new McpServer({
      name: 'language-track-bridge',
      version: '1.0.0'
    });

    // Format counterparty description for tool descriptions
    const counterpartyName = bridgeCtx.counterparties[0]?.principal?.name || 'the other agent';
    const counterpartyDesc = bridgeCtx.counterparties[0]?.principal?.description || '';
    const counterpartyTools = bridgeCtx.counterparties[0]?.tools.map(t => t.toolName).join(', ') || 'none';
    
    // Register begin_chat_thread with dynamic description
    server.registerTool(
      'begin_chat_thread',
      {
        title: 'Begin Chat Thread',
        description: `Begin a conversation with ${counterpartyName}. Scenario: ${bridgeCtx.scenario.title} — ${bridgeCtx.scenario.description}. Counterparty capabilities include: ${counterpartyTools}`,
        inputSchema: beginChatThreadSchema
      },
      this.beginChatThreadHandler.bind(this)
    );

    // Register send_message_to_chat_thread with dynamic description
    server.registerTool(
      'send_message_to_chat_thread',
      {
        title: 'Send Message to Chat Thread',
        description: `Send a message to ${counterpartyName} (${counterpartyDesc}). Use attachments to share documents.`,
        inputSchema: sendMessageSchema
      },
      this.sendMessageHandler.bind(this)
    );

    // Register wait_for_reply with dynamic description
    server.registerTool(
      'wait_for_reply',
      {
        title: 'Wait for Reply',
        description: `Wait for ${counterpartyName}'s next reply. If you time out, call this again. See returned status for conversation progress.`,
        inputSchema: waitForReplySchema
      },
      this.waitForReplyHandler.bind(this)
    );

    return server;
  }

  /**
   * Handle an HTTP request using the MCP server with StreamableHTTPServerTransport
   * This now works with our Hono-to-Node adapters
   */
  public async handleRequest(req: any, res: any, body: any): Promise<void> {
    // Decode and validate config
    const config = decodeConfigFromBase64URL(this.config64);
    const validation = validateCreateConversationConfigV2(config);
    
    if (!validation.valid) {
      throw new Error(`Invalid configuration: ${validation.errors.join(', ')}`);
    }
    
    // Find the bridged agent
    const bridgedAgent = getBridgedAgent(config);
    if (!bridgedAgent) {
      throw new Error('No bridged agent found in configuration');
    }

    // Load bridge context from scenario (without instantiating agents)
    const bridgeCtx = await BridgeAgent.getBridgeContextFromScenario(
      this.orchestrator.getDbInstance(),
      this.scenarioId,
      bridgedAgent.id
    );

    // Build a new MCP server with context-aware descriptions
    const contextualServer = await this.buildServerWithContext(bridgeCtx);
    
    // Create a new transport for this request (stateless mode)
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // Stateless mode
      enableJsonResponse: true // Prefer JSON responses over SSE
    });
    
    try {
      // Connect the contextual MCP server to the transport
      await contextualServer.connect(transport);
      
      // Let the transport handle the request
      await transport.handleRequest(req, res, body);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      throw error;
    }
  }

  public async cleanup() {
    // Bridge agents self-manage their lifecycle through the orchestrator
  }
}