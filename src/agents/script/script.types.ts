export type ScriptAction =
  | { kind: 'post'; text: string; finality?: 'none' | 'turn' | 'conversation'; delayMs?: number }
  | { kind: 'trace'; payload: { type: 'thought' | 'tool_call' | 'tool_result'; [k: string]: unknown }; delayMs?: number }
  | { kind: 'sleep'; ms: number }
  | { kind: 'assert'; predicate: 'lastMessageContains'; text: string };

export interface AgentScript {
  name: string;
  steps: ScriptAction[];
}

// Turn-based script for demos - each turn gets its own set of actions
export interface TurnBasedScript {
  name: string;
  defaultDelay?: number;  // Default delay between actions in ms
  turns: ScriptAction[][];  // Array of turns, each containing an array of actions
  maxTurns?: number;  // Max turns before ending conversation
}