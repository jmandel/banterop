// Model-agnostic LLM types
export interface LLMMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMRequest {
  messages: LLMMessage[];
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface LLMResponse {
  content: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  finishReason?: 'stop' | 'length' | 'tool_calls' | 'content_filter' | 'function_call';
}

export interface LLMTool {
  name: string;
  description: string;
  inputSchema: object;
}

export interface LLMToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMToolResponse {
  name: string;
  content: string;
  error?: string;
}

// Provider metadata - static information about a provider
export interface LLMProviderMetadata {
  name: string;
  description: string;
  models: string[];
  defaultModel: string;
}

// Provider configuration
export interface LLMProviderConfig {
  provider: 'google' | 'openai' | 'anthropic' | 'local' | 'remote' | 'openrouter'
  apiKey?: string;
  baseURL?: string;
  model?: string;
}

// Abstract LLM provider interface
export abstract class LLMProvider {
  protected config: LLMProviderConfig;
  protected debugEnabled: boolean = process.env.DEBUG_LLM === 'true';
  
  constructor(config: LLMProviderConfig) {
    this.config = config;
  }
  
  /**
   * Generate a response from the LLM with automatic debug logging
   */
  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    // Debug logging for all providers
    if (this.debugEnabled) {
      await this.logLLMDebug(request, null, 'request');
    }
    
    try {
      // Call the provider-specific implementation
      const response = await this.generateResponseImpl(request);
      
      // Debug logging for response
      if (this.debugEnabled) {
        await this.logLLMDebug(request, response, 'response');
      }
      
      return response;
    } catch (error) {
      // Log errors too
      if (this.debugEnabled) {
        await this.logLLMDebug(request, error, 'error');
      }
      throw error;
    }
  }
  
  /**
   * Provider-specific implementation of generateResponse
   * This is what subclasses should implement instead of generateResponse
   */
  protected abstract generateResponseImpl(request: LLMRequest): Promise<LLMResponse>;
  
  abstract getSupportedModels(): string[];
  
  abstract getDescription(): string;
  
  private debugFileMap: Map<string, string> = new Map();
  
  /**
   * Unified debug logging for all LLM calls
   */
  protected async logLLMDebug(request: LLMRequest, response: LLMResponse | Error | null, phase: 'request' | 'response' | 'error'): Promise<void> {
    try {
      const fs = await import('fs');
      const path = await import('path');
      
      // Create debug directory if it doesn't exist
      const debugDir = './debug';
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      
      // Create a request ID for correlation
      const requestId = `${Date.now()}_${Math.random().toString(36).substring(7)}`;
      
      let debugFile: string;
      let content = '';
      
      if (phase === 'request') {
        // Create new file for request
        const timestamp = new Date().toISOString().replace(/:/g, '-').replace(/\./g, '_');
        const provider = this.config.provider;
        debugFile = path.join(debugDir, `llm-${provider}-${timestamp}.txt`);
        
        // Store filename for this request
        this.debugFileMap.set(requestId, debugFile);
        
        // Start with metadata
        content = `LLM Debug Log\n`;
        content += `${'='.repeat(80)}\n`;
        content += `Provider: ${provider}\n`;
        content += `Model: ${request.model || this.config.model || 'default'}\n`;
        content += `Request Time: ${new Date().toISOString()}\n`;
        content += `Temperature: ${request.temperature || 'default'}\n`;
        content += `Max Tokens: ${request.maxTokens || 'default'}\n`;
        content += `${'='.repeat(80)}\n\n`;
        
        // Log the request
        content += `REQUEST CONTENT (${request.messages[0]?.content?.length || 0} chars):\n`;
        content += `${'-'.repeat(80)}\n`;
        content += request.messages[0]?.content || '(empty)';
        content += `\n${'-'.repeat(80)}\n`;
        
        // Write initial file
        fs.writeFileSync(debugFile, content);
        console.log(`[LLM Debug] Request logged to ${debugFile}`);
        
        // Return the request ID in the metadata for correlation
        (request as any).__debugRequestId = requestId;
        
      } else {
        // Get the request ID and file
        const storedRequestId = (request as any).__debugRequestId;
        debugFile = this.debugFileMap.get(storedRequestId) || '';
        
        if (!debugFile) {
          console.warn('[LLM Debug] No debug file found for response/error');
          return;
        }
        
        if (phase === 'response' && response && !(response instanceof Error)) {
          // Append the response
          content = `\n\nRESPONSE (received at ${new Date().toISOString()}):\n`;
          content += `${'='.repeat(80)}\n`;
          content += `Response Length: ${response.content?.length || 0} chars\n`;
          
          if (response.usage) {
            content += `Token Usage:\n`;
            content += `  Prompt: ${response.usage.promptTokens}\n`;
            content += `  Completion: ${response.usage.completionTokens}\n`;
            content += `  Total: ${response.usage.totalTokens}\n`;
          }
          
          content += `${'-'.repeat(80)}\n`;
          content += response.content || '(empty)';
          content += `\n${'-'.repeat(80)}\n`;
          content += `\n[END OF RESPONSE]\n`;
          
          // Append to existing file
          fs.appendFileSync(debugFile, content);
          console.log(`[LLM Debug] Response appended to ${debugFile}`);
          
          // Clean up the map entry
          this.debugFileMap.delete(storedRequestId);
          
        } else if (phase === 'error' && response instanceof Error) {
          // Append the error
          content = `\n\nERROR (occurred at ${new Date().toISOString()}):\n`;
          content += `${'='.repeat(80)}\n`;
          content += `${response.message}\n`;
          content += `${response.stack || ''}\n`;
          content += `${'-'.repeat(80)}\n`;
          
          // Append to existing file
          fs.appendFileSync(debugFile, content);
          console.log(`[LLM Debug] Error appended to ${debugFile}`);
          
          // Clean up the map entry
          this.debugFileMap.delete(storedRequestId);
        }
      }
      
    } catch (err) {
      console.error('[LLM Debug] Failed to write debug log:', err);
    }
  }
}