export interface ScenarioDrivenAgentOptions {
  agentId: string;                        // ID matching an agent in the scenario
  maxStepsPerTurn?: number;               // Reserved for future multi-step support (default: 1)
  useOracle?: boolean;                    // Reserved for future oracle/tool synthesis support
}

// For future tool synthesis
export interface ToolCall {
  name: string;
  args?: Record<string, unknown>;
}

export interface OracleResult {
  reasoning: string;
  output: unknown;
}