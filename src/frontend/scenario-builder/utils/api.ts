import type { ScenarioConfiguration } from '$lib/types.js';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

// API base URL - configurable for development vs production
const API_BASE_URL = import.meta.env?.VITE_API_BASE_URL || 'http://localhost:3001';

// API client functions
export const api = {
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
  }
};