import type { ScenarioConfiguration, CreateConversationRequest, CreateConversationResponse, LLMRequest, LLMResponse } from '$lib/types.js';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// API base URL - configurable for development vs production
// When served via Bun's HTML dev server, import.meta.env may not be available
const API_BASE_URL = import.meta.env?.API_BASE_URL || 'http://localhost:3001';

// API client functions
export const api = {
  getBaseUrl() {
    return API_BASE_URL;
  },
  
  async getScenarios() {
    const response = await fetch(`${API_BASE_URL}/api/scenarios`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  },
  
  async getScenario(id: string) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios/${id}`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  },
  
  async createScenario(name: string, config: ScenarioConfiguration, history: ChatMessage[] = []) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, config, history })
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  },
  
  async updateScenario(id: string, updates: any) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  },
  
  async updateScenarioConfig(id: string, config: ScenarioConfiguration) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios/${id}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  },
  
  async deleteScenario(id: string) {
    const response = await fetch(`${API_BASE_URL}/api/scenarios/${id}`, {
      method: 'DELETE'
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  },
  
  async chatWithScenario(id: string, message: string, history: ChatMessage[]) {
    const response = await fetch(`${API_BASE_URL}/api/llm/scenario-chat/${id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history })
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  },
  
  async createConversation(config: CreateConversationRequest) {
    const response = await fetch(`${API_BASE_URL}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config)
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    const data: CreateConversationResponse = await response.json();
    return { success: true, data };
  },
  
  async startConversation(conversationId: string) {
    const response = await fetch(`${API_BASE_URL}/api/conversations/${conversationId}/start`, {
      method: 'POST'
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  },
  
  async generateLLM(request: LLMRequest, signal?: AbortSignal) {
    const response = await fetch(`${API_BASE_URL}/api/llm/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal
    });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  },
  
  async getLLMConfig() {
    const response = await fetch(`${API_BASE_URL}/api/llm/config`);
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return response.json();
  }
};