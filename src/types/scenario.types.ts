export interface ScenarioConfig {
  id: string;
  name: string;
  description?: string;
  agents: AgentConfig[];
  systemPrompt?: string;
  tools?: ToolConfig[];
}

export interface AgentConfig {
  id: string;
  name: string;
  type: 'internal' | 'external';
  systemPrompt?: string;
  tools?: string[]; // Tool IDs this agent can use
}

export interface ToolConfig {
  id: string;
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}