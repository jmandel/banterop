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
  
  getSupportedModels(): string[] {
    return [
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.5-pro',
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
          temperature: request.temperature,
          maxOutputTokens: request.maxTokens,
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
}