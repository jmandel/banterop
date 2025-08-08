import { GoogleGenAI } from '@google/genai';
import { LLMProvider, type LLMProviderConfig, type LLMProviderMetadata, type LLMRequest, type LLMResponse, type LLMMessage } from '$src/types/llm.types';

export class GoogleLLMProvider extends LLMProvider {
  private client: GoogleGenAI | null = null;
  
  constructor(config: LLMProviderConfig) {
    super(config);
    if (config.apiKey) {
      this.client = new GoogleGenAI({ apiKey: config.apiKey });
    }
  }
  
  static getMetadata(): LLMProviderMetadata {
    return {
      name: 'google',
      description: 'Google Gemini models via @google/genai',
      models: ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-2.5-pro'],
      defaultModel: 'gemini-2.5-flash-lite',
    };
  }
  
  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) {
      throw new Error('Google AI client not initialized - API key required');
    }
    
    const modelName = request.model || this.config.model || this.getMetadata().defaultModel;
    
    // Convert messages to Google format
    const contents = this.convertMessagesToGoogleFormat(request.messages);
    
    // Generate response
    const response = await this.client.models.generateContent({
      model: modelName,
      contents: contents,
      config: {
        ...(request.temperature !== undefined ? { temperature: request.temperature } : {}),
        ...(request.maxTokens !== undefined ? { maxOutputTokens: request.maxTokens } : {}),
      }
    });
    
    const text = response.text || '';
    
    return {
      content: text,
    };
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