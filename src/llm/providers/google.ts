import { GoogleGenAI } from '@google/genai';
import { LLMProvider, LLMRequest, LLMResponse, LLMMessage, LLMTool, LLMToolCall, LLMToolResponse } from 'src/types/llm.types.js';

export class GoogleLLMProvider extends LLMProvider {
  private client: GoogleGenAI | null = null;
  
  constructor(config: { apiKey?: string; model?: string }) {
    // Use provided API key or fall back to environment variable
    const apiKey = config.apiKey || process.env.GEMINI_API_KEY;
    
    super({
      provider: 'google',
      apiKey: apiKey,
      model: config.model || 'gemini-2.5-flash-lite'
    });
    
    if (apiKey) {
      this.client = new GoogleGenAI({ apiKey: apiKey });
    }
  }
  
  async isAvailable(): Promise<boolean> {
    return this.client !== null;
  }
  
  getSupportedModels(): string[] {
    return [
      'gemini-2.5-flash-lite',
      'gemini-2.0-flash-exp',
      'gemini-1.5-flash',
      'gemini-1.5-pro',
      'gemini-1.0-pro'
    ];
  }
  
  async generateResponse(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('Google AI client not initialized - API key required');
    }
    
    try {
      // Convert messages to Google format
      const contents = this.convertMessagesToGoogleFormat(request.messages);
      
      const response = await this.client.models.generateContent({
        model: request.model || this.config.model || 'gemini-2.5-flash-lite',
        contents: contents,
        config: {
          temperature: request.temperature || 0.7,
          maxOutputTokens: request.maxTokens || 2048,
        }
      });
      
      const text = response.text || '';
      
      return {
        content: text,
        finishReason: 'stop',
        usage: {
          promptTokens: 0, // Google doesn't provide detailed token counts in the same way
          completionTokens: 0,
          totalTokens: 0
        }
      };
    } catch (error) {
      console.error('Google LLM generation error:', error);
      throw new Error(`Google LLM generation failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  async generateWithTools(
    messages: LLMMessage[],
    tools: LLMTool[],
    toolHandler: (call: LLMToolCall) => Promise<LLMToolResponse>
  ): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('Google AI client not initialized - API key required');
    }
    
    try {
      const contents = this.convertMessagesToGoogleFormat(messages);
      const googleTools = this.convertToolsToGoogleFormat(tools);
      
      const response = await this.client.models.generateContent({
        model: this.config.model || 'gemini-2.5-flash-lite',
        contents: contents,
        config: {
          tools: googleTools
        }
      });
      
      // Check if there are function calls
      const functionCalls = response.functionCalls;
      if (functionCalls && functionCalls.length > 0) {
        // Handle function calls
        const toolResults = [];
        
        for (const call of functionCalls) {
          try {
            const toolResponse = await toolHandler({
              name: call.name || '',
              arguments: call.args || {}
            });
            
            toolResults.push({
              functionResponse: {
                name: call.name || '',
                response: { content: toolResponse.content }
              }
            });
          } catch (error) {
            toolResults.push({
              functionResponse: {
                name: call.name || '',
                response: { error: error instanceof Error ? error.message : 'Tool execution failed' }
              }
            });
          }
        }
        
        // Generate final response with tool results
        const baseContents = Array.isArray(contents) ? contents : [{ parts: [{ text: contents }] }];
        const finalContents = [
          ...baseContents,
          { role: 'model', parts: [{ text: response.text || '' }] },
          { role: 'user', parts: toolResults }
        ];
        
        const finalResponse = await this.client.models.generateContent({
          model: this.config.model || 'gemini-2.5-flash-lite',
          contents: finalContents
        });
        
        return {
          content: finalResponse.text || '',
          finishReason: 'stop',
          usage: {
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0
          }
        };
      }
      
      // No function calls, return regular response
      return {
        content: response.text || '',
        finishReason: 'stop',
        usage: {
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0
        }
      };
    } catch (error) {
      console.error('Google LLM with tools error:', error);
      throw new Error(`Google LLM with tools failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
  
  private convertMessagesToGoogleFormat(messages: LLMMessage[]) {
    let systemMessage = '';
    
    // Extract system message if present
    const systemMsg = messages.find(m => m.role === 'system');
    if (systemMsg) {
      systemMessage = systemMsg.content;
    }
    
    // Convert remaining messages to Google format
    const nonSystemMessages = messages.filter(m => m.role !== 'system');
    
    // Google's new API expects a single content string or array of parts
    if (nonSystemMessages.length === 1 && nonSystemMessages[0]!.role === 'user') {
      // Single user message - can pass as string with system prompt prepended
      let content = nonSystemMessages[0]!.content;
      if (systemMessage) {
        content = `${systemMessage}\n\n${content}`;
      }
      return content;
    }
    
    // Multiple messages - convert to Content format with proper structure
    const contentArray = [];
    
    if (systemMessage) {
      contentArray.push({ parts: [{ text: systemMessage }] });
    }
    
    for (const message of nonSystemMessages) {
      contentArray.push({
        role: message.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: message.content }]
      });
    }
    
    return contentArray;
  }
  
  private convertToolsToGoogleFormat(tools: LLMTool[]) {
    return [{
      functionDeclarations: tools.map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.inputSchema
      }))
    }];
  }
}