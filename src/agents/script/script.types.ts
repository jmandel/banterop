export type ScriptAction =
  | { kind: 'post'; text: string; finality?: 'none' | 'turn' | 'conversation'; delayMs?: number }
  | { kind: 'trace'; payload: { type: 'thought' | 'tool_call' | 'tool_result'; [k: string]: unknown }; delayMs?: number }
  | { kind: 'wait'; timeoutMs: number }
  | { kind: 'sleep'; ms: number }
  | { kind: 'assert'; predicate: 'lastMessageContains'; text: string }
  | { kind: 'yield' };

export interface AgentScript {
  name: string;
  steps: ScriptAction[];
}