// Transport-Agnostic Agent Logic Classes
// Pure agent business logic that works with any OrchestratorClient implementation

import { v4 as uuidv4 } from 'uuid';
import type { OrchestratorClient } from '$client/index.js';
import type { ConversationEvent, AgentId } from '$lib/types.js';

// ============= Base Agent Class =============

export abstract class BaseTransportAgnosticAgent {
  protected client: OrchestratorClient;
  protected conversationId?: string;
  protected subscriptionId?: string;
  public readonly agentId: AgentId;

  constructor(agentId: AgentId, client: OrchestratorClient) {
    this.agentId = agentId;
    this.client = client;
    
    // Set up event handlers
    this.client.on('event', this.handleEvent.bind(this));
  }

  async initialize(conversationId: string, authToken: string): Promise<void> {
    this.conversationId = conversationId;
    
    // Connect and authenticate
    await this.client.connect(authToken);
    await this.client.authenticate(authToken);
    
    // Subscribe to conversation events
    this.subscriptionId = await this.client.subscribe(conversationId);
    
    console.log(`Agent ${this.agentId.label} initialized for conversation ${conversationId}`);
  }

  async shutdown(): Promise<void> {
    if (this.subscriptionId) {
      await this.client.unsubscribe(this.subscriptionId);
    }
    this.client.disconnect();
    console.log(`Agent ${this.agentId.label} shutting down`);
  }

  private handleEvent(event: ConversationEvent, subscriptionId: string) {
    if (subscriptionId === this.subscriptionId) {
      // Don't await - let it run async and handle its own errors
      this.onConversationEvent(event).catch(error => {
        console.log(`Agent ${this.agentId.id} async event handler error: ${error.message}`);
      });
    }
  }

  async onConversationEvent(event: ConversationEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'turn_completed':
          if (event.data.turn.agentId !== this.agentId.id) {
            await this.onOtherAgentTurn(event);
          }
          break;
        case 'conversation_ended':
          await this.shutdown();
          break;
      }
    } catch (error) {
      console.log(`Agent ${this.agentId.id} conversation event error: ${error.message}`);
    }
  }

  // Abstract methods that concrete agents must implement
  abstract onOtherAgentTurn(event: ConversationEvent): Promise<void>;
  
  // Helper methods for agent actions
  protected async submitSimpleTurn(content: string, thoughts?: string[]): Promise<void> {
    const trace = thoughts ? thoughts.map(thought => ({
      id: uuidv4(),
      agentId: this.agentId.id,
      timestamp: new Date(),
      type: 'thought' as const,
      content: thought
    })) : [];

    // TODO: Update to use new streaming pattern (startTurn + completeTurn)
    // await this.client.submitTurn(content, trace);
  }

  protected async submitStreamingTurn(content: string, thoughts?: string[], toolCalls?: Array<{name: string, parameters: any, result: any}>): Promise<void> {
    try {
      const turnId = await this.client.startTurn();

      // Add thoughts
      if (thoughts) {
        for (const thought of thoughts) {
          await this.client.addTrace(turnId, {
            type: 'thought',
            content: thought
          });
          await this.sleep(200); // Simulate thinking time
        }
      }

      // Add tool calls
      if (toolCalls) {
        for (const tool of toolCalls) {
          await this.client.addTrace(turnId, {
            type: 'tool_call',
            toolName: tool.name,
            parameters: tool.parameters,
            toolCallId: uuidv4()
          });
          await this.sleep(300); // Simulate tool execution time

          await this.client.addTrace(turnId, {
            type: 'tool_result',
            toolCallId: uuidv4(),
            result: tool.result
          });
          await this.sleep(100);
        }
      }

      await this.client.completeTurn(turnId, content);
    } catch (error) {
      console.log(`Agent ${this.agentId.id} failed to submit streaming turn: ${error.message}`);
      // Don't rethrow - this prevents hanging on authentication failures
    }
  }

  protected async queryUser(question: string, context?: Record<string, any>): Promise<string> {
    const queryId = await this.client.createUserQuery(question, context);
    
    // Wait for response via events
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('User query timeout'));
      }, 300000); // 5 minutes

      const handleQueryResponse = (event: ConversationEvent) => {
        if (event.type === 'user_query_answered' && event.data.queryId === queryId) {
          clearTimeout(timeout);
          this.client.off('event', handleQueryResponse);
          resolve(event.data.response);
        }
      };

      this.client.on('event', handleQueryResponse);
    });
  }

  protected async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// ============= Customer Support Agent =============

export class SupportAgent extends BaseTransportAgnosticAgent {
  async onOtherAgentTurn(event: ConversationEvent): Promise<void> {
    // Support agent responds to technical specialist recommendations
    if (event.data.turn.agentId === 'tech-specialist' && 
        event.data.turn.content.includes('recommend')) {
      
      await this.sleep(1000); // Simulate processing time
      
      await this.submitStreamingTurn(
        'Thank you for the technical analysis! I\'ll contact the customer immediately with these recommendations and gather the additional information you need for further optimization.',
        [
          'I need to translate the technical recommendations into customer-friendly guidance',
          'I should also schedule a follow-up to ensure proper implementation'
        ],
        [{
          name: 'create_customer_response',
          parameters: { 
            technical_details: 'connection pooling and database scaling',
            urgency: 'high'
          },
          result: { template_created: true, customer_priority: 'high' }
        }]
      );
    }
  }

  async handleInitialCustomerIssue(issueDescription: string): Promise<void> {
    await this.submitStreamingTurn(
      `Hello! I have a customer with a technical issue that needs specialist attention. ${issueDescription}`,
      [
        'This looks like a technical issue that requires specialist expertise',
        'I should escalate this to our technical team for proper analysis'
      ]
    );
  }

  async coordinateFollowUp(): Promise<void> {
    await this.sleep(1500);
    
    await this.submitStreamingTurn(
      'Excellent! I\'ll schedule a follow-up call with the customer to review the implementation plan and provide the technical resources. This collaborative approach should resolve their timeout issues quickly.',
      [
        'I need to coordinate the next steps with the customer',
        'A structured follow-up will ensure successful implementation'
      ],
      [{
        name: 'schedule_follow_up',
        parameters: { customer_id: 'cust-123', priority: 'high', include_resources: true },
        result: { meeting_scheduled: true, calendar_updated: true }
      }]
    );
  }
}

// ============= Technical Specialist Agent =============

export class TechSpecialistAgent extends BaseTransportAgnosticAgent {
  async onOtherAgentTurn(event: ConversationEvent): Promise<void> {
    // Tech specialist responds to support agent escalations
    if (event.data.turn.agentId === 'support-agent' && 
        (event.data.turn.content.includes('technical issue') || 
         event.data.turn.content.includes('database connection'))) {
      
      await this.sleep(1000); // Simulate analysis time
      
      await this.provideTechnicalAnalysis();
    }
    
    // Offer additional resources when support agent confirms understanding
    if (event.data.turn.agentId === 'support-agent' && 
        event.data.turn.content.includes('contact the customer')) {
      
      await this.sleep(1000);
      
      await this.offerAdditionalResources();
    }
  }

  private async provideTechnicalAnalysis(): Promise<void> {
    await this.submitStreamingTurn(
      'I\'ve analyzed the issue. The database is experiencing high load with 180 active connections and 45-second response times. I recommend implementing connection pooling and possibly scaling the database instance. Can you ask the customer about their current connection management strategy?',
      [
        'I need to analyze this database connection timeout issue systematically',
        'Let me check the current database performance metrics',
        'Based on the results, I can provide specific recommendations'
      ],
      [{
        name: 'check_database_status',
        parameters: { timeout_threshold: 30 },
        result: { status: 'degraded', avg_response_time: 45000, active_connections: 180 }
      }, {
        name: 'analyze_connection_patterns',
        parameters: { timeframe: '24h' },
        result: { connection_spikes: true, peak_hours: ['09:00-11:00', '14:00-16:00'], pool_utilization: 0.95 }
      }]
    );
  }

  private async offerAdditionalResources(): Promise<void> {
    await this.submitSimpleTurn(
      'Perfect approach! Additionally, I can provide the customer with a connection pooling configuration template and monitoring scripts to track their database performance. Would you like me to prepare these resources?',
      [
        'Offering proactive technical resources will help prevent future issues',
        'I should prepare comprehensive documentation for the customer'
      ]
    );
  }
}

// ============= Demo Orchestration Helper =============

export class DemoOrchestrator {
  private supportAgent: SupportAgent;
  private techSpecialist: TechSpecialistAgent;

  constructor(supportClient: OrchestratorClient, techClient: OrchestratorClient) {
    this.supportAgent = new SupportAgent(
      { id: 'support-agent', label: 'Customer Support Agent', role: 'assistant' },
      supportClient
    );
    
    this.techSpecialist = new TechSpecialistAgent(
      { id: 'tech-specialist', label: 'Technical Specialist', role: 'specialist' },
      techClient
    );
  }

  async initializeAgents(conversationId: string, agentTokens: Record<string, string>): Promise<void> {
    await Promise.all([
      this.supportAgent.initialize(conversationId, agentTokens['support-agent']),
      this.techSpecialist.initialize(conversationId, agentTokens['tech-specialist'])
    ]);
  }

  async runDemo(): Promise<void> {
    console.log('🤖 Starting multi-agent conversation...');
    
    // Start with customer issue
    await this.supportAgent.handleInitialCustomerIssue(
      'The customer is experiencing database connection timeouts.'
    );
    
    // Wait for tech specialist to analyze and respond
    await this.sleep(8000);
    
    // Support agent coordinates follow-up
    await this.supportAgent.coordinateFollowUp();
    
    console.log('✅ Multi-agent conversation completed!');
  }

  async shutdown(): Promise<void> {
    await Promise.all([
      this.supportAgent.shutdown(),
      this.techSpecialist.shutdown()
    ]);
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}