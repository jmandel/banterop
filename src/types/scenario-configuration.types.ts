export interface ScenarioMetadata {
  id: string;
  title: string;
  description: string;
  category: string;
  tags: string[];
  difficulty: 'basic' | 'intermediate' | 'advanced';
  estimatedDuration: number;
  version: string;
}

export interface AgentDefinition {
  agentId: string;
  role: string;
  name: string;
  description: string;
  capabilities: string[];
  goals: string[];
  constraints: string[];
  systemPrompt?: string;
  config?: Record<string, unknown>;
}

export interface ScenarioStage {
  id: string;
  name: string;
  description: string;
  order: number;
  requiredAgents: string[];
  expectedOutcomes: string[];
  timeLimit?: number;
}

export interface ScenarioRules {
  turnLimit?: number;
  messageLimit?: number;
  allowedMessageTypes: string[];
  requiredAttachments?: string[];
  successCriteria: string[];
  failureCriteria: string[];
}

export interface ScenarioKnowledge {
  facts: string[];
  documents?: Array<{
    id: string;
    title: string;
    content: string;
    type: string;
  }>;
  references?: Array<{
    title: string;
    url: string;
  }>;
}

export interface ScenarioConfiguration {
  metadata: ScenarioMetadata;
  agents: AgentDefinition[];
  stages?: ScenarioStage[];
  rules?: ScenarioRules;
  knowledge?: ScenarioKnowledge;
  config?: Record<string, unknown>;
  custom?: Record<string, unknown>;
}