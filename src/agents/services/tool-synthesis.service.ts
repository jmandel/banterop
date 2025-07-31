// Tool Synthesis Service with deterministic caching using Bun crypto
import type { LLMProvider } from "src/types/llm.types.js";
import type { ScenarioConfiguration, TraceEntry } from "$lib/types.js";

export interface ToolExecutionInput {
  toolName: string;
  args: Record<string, unknown>;
  runId: string;
  role: string;
  scenario: ScenarioConfiguration;
}

export interface ToolExecutionOutput {
  output: unknown;
  steps: TraceEntry[];
}

interface CachedResult {
  output: unknown;
  steps: TraceEntry[];
  timestamp: number;
}

export class ToolSynthesisService {
  private cache = new Map<string, CachedResult>();
  
  constructor(private llm: LLMProvider) {}

  async execute(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    try {
      // Create deterministic cache key using Bun's crypto
      const cacheKey = await this.createCacheKey(input);
      
      // Check cache first
      const cached = this.cache.get(cacheKey);
      if (cached) {
        return {
          output: cached.output,
          steps: [
            ...cached.steps,
            {
              id: `cache_${Date.now()}`,
              agentId: input.runId,
              type: 'thought',
              timestamp: new Date(),
              content: `Cache hit: Using cached result for deterministic replay (key: ${cacheKey.slice(0, 8)}...)`
            }
          ]
        };
      }
      
      // Synthesize with LLM
      const result = await this.synthesizeWithLLM(input);
      
      // Cache the result
      this.cache.set(cacheKey, {
        ...result,
        timestamp: Date.now()
      });
      
      return result;
    } catch (error) {
      // Top-level error handling for cache or synthesis issues
      console.error(`Tool synthesis execute failed for ${input.toolName}:`, error);
      
      return {
        output: {
          error: 'Tool synthesis failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        },
        steps: [{
          id: `error_${Date.now()}`,
          agentId: input.runId,
          type: 'thought',
          timestamp: new Date(),
          content: `Tool synthesis failed: ${error instanceof Error ? error.message : 'Unknown error'}`
        }]
      };
    }
  }

  // Create deterministic cache key using Bun's crypto
  private async createCacheKey(input: ToolExecutionInput): Promise<string> {
    try {
      // Normalize input for consistent hashing
      const normalized = {
        toolName: input.toolName,
        args: this.sortObject(input.args),
        role: input.role,
        scenarioId: input.scenario.scenarioMetadata.id,
        schemaVersion: input.scenario.scenarioMetadata.schemaVersion
      };
      
      const jsonString = JSON.stringify(normalized);
      
      // Use Bun's built-in crypto for hashing
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(jsonString);
      return hasher.digest("hex");
    } catch (error) {
      // Fallback to simple string-based key if crypto fails
      console.warn('Failed to create crypto cache key, using fallback:', error);
      
      return `${input.toolName}_${input.role}_${JSON.stringify(input.args).slice(0, 50)}`;
    }
  }

  // Synthesize tool execution with LLM
  private async synthesizeWithLLM(input: ToolExecutionInput): Promise<ToolExecutionOutput> {
    const { toolName, args, role, scenario } = input;
    
    // Find tool definition
    const agentConfig = role === 'PatientAgent' ? scenario.patientAgent : scenario.supplierAgent;
    const tool = agentConfig.tools.find(t => t.toolName === toolName);
    
    if (!tool) {
      throw new Error(`Tool ${toolName} not found for role ${role}`);
    }

    // Build synthesis prompt
    const prompt = this.buildSynthesisPrompt(tool, args, role, scenario);
    
    const messages = [{ role: 'user' as const, content: prompt }];
    
    try {
      const response = await this.llm.generateResponse({ messages });
      
      // Parse the structured response
      let parsed;
      try {
        parsed = this.parseToolResponse(response.content);
      } catch (parseError) {
        // Handle parsing errors specifically
        console.error(`Failed to parse tool response for ${toolName}:`, parseError);
        
        return {
          output: {
            error: 'Tool response parsing failed',
            message: parseError instanceof Error ? parseError.message : 'Unknown parsing error',
            rawContent: response.content.slice(0, 200)
          },
          steps: [{
            id: `parse_error_${Date.now()}`,
            agentId: input.runId,
            type: 'thought',
            timestamp: new Date(),
            content: `Response parsing failed: ${parseError instanceof Error ? parseError.message : 'Unknown parsing error'}`
          }]
        };
      }
      
      // Create execution steps
      const toolCallId = `call_${Date.now()}`;
      const steps: TraceEntry[] = [
        {
          id: `thought_${Date.now()}`,
          agentId: input.runId,
          type: 'thought',
          timestamp: new Date(),
          content: `Analyzing tool request: Processing ${toolName} with args: ${JSON.stringify(args)}`
        },
        {
          id: `tool_call_${Date.now()}`,
          agentId: input.runId,
          type: 'tool_call',
          timestamp: new Date(),
          toolName: toolName,
          parameters: args,
          toolCallId: toolCallId
        },
        {
          id: `tool_result_${Date.now()}`,
          agentId: input.runId,
          type: 'tool_result',
          timestamp: new Date(),
          toolCallId: toolCallId,
          result: parsed.output
        },
        {
          id: `synthesis_${Date.now()}`,
          agentId: input.runId,
          type: 'thought',
          timestamp: new Date(),
          content: `${parsed.summary || 'Tool execution completed'}${parsed.reasoning ? ': ' + parsed.reasoning : ''}`
        }
      ];
      
      return {
        output: parsed.output,
        steps
      };
      
    } catch (error) {
      // LLM generation error
      console.error(`LLM generation failed for tool ${toolName}:`, error);
      
      // Create error steps
      const errorSteps: TraceEntry[] = [
        {
          id: `llm_error_${Date.now()}`,
          agentId: input.runId,
          type: 'thought',
          timestamp: new Date(),
          content: `LLM generation failed: ${error instanceof Error ? error.message : 'Unknown LLM error'}`
        }
      ];
      
      return {
        output: {
          error: 'LLM generation failed',
          message: error instanceof Error ? error.message : 'Unknown error'
        },
        steps: errorSteps
      };
    }
  }

  // Build prompt for tool synthesis
  private buildSynthesisPrompt(tool: any, args: Record<string, unknown>, role: string, scenario: ScenarioConfiguration): string {
    const agentConfig = role === 'PatientAgent' ? scenario.patientAgent : scenario.supplierAgent;
    const context = role === 'PatientAgent' 
      ? ('clinicalSketch' in agentConfig ? agentConfig.clinicalSketch : {})
      : ('operationalContext' in agentConfig ? agentConfig.operationalContext : {});

    return `You are a tool synthesis engine for healthcare interoperability scenarios. Your job is to simulate realistic tool execution results.

TOOL DEFINITION:
Name: ${tool.toolName}
Description: ${tool.description}
Input Schema: ${JSON.stringify(tool.inputSchema, null, 2)}
Output Description: ${tool.outputDescription}
Synthesis Guidance: ${tool.synthesisGuidance}

EXECUTION CONTEXT:
Role: ${role}
Principal: ${agentConfig.principalIdentity}
Context: ${JSON.stringify(context, null, 2)}

TOOL INVOCATION:
Arguments: ${JSON.stringify(args, null, 2)}

INSTRUCTIONS:
1. Validate that the arguments match the input schema
2. Generate a realistic output based on the tool description and synthesis guidance
3. Consider the agent's context and scenario constraints
4. Provide reasoning for the generated output

OUTPUT FORMAT (JSON):
{
  "valid": true/false,
  "output": { /* realistic tool output */ },
  "summary": "Brief description of what happened",
  "reasoning": "Why this output makes sense given the context"
}

If arguments are invalid, set "valid": false and explain why in "reasoning".`;
  }

  // Parse structured tool response
  private parseToolResponse(content: string): { output: unknown; summary?: string; reasoning?: string } {
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      // Fallback parsing if JSON is malformed
      console.warn('Tool response was not valid JSON, using fallback synthesis');
      
      return {
        output: { 
          synthesized: true, 
          content: content.slice(0, 200),
          fallback: true
        },
        summary: 'Tool executed with fallback synthesis',
        reasoning: 'LLM response was not valid JSON, using fallback synthesis'
      };
    }
    
    // Validate parsed response structure
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('Tool response must be a JSON object');
    }
    
    if (parsed.valid === false) {
      throw new Error(`Invalid tool arguments: ${parsed.reasoning || 'Unknown validation error'}`);
    }
    
    return {
      output: parsed.output || {},
      summary: parsed.summary,
      reasoning: parsed.reasoning
    };
  }

  // Sort object keys for consistent hashing
  private sortObject(obj: Record<string, unknown>): Record<string, unknown> {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(obj).sort();
    
    for (const key of keys) {
      const value = obj[key];
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        sorted[key] = this.sortObject(value as Record<string, unknown>);
      } else {
        sorted[key] = value;
      }
    }
    
    return sorted;
  }

  // Clear cache (for testing)
  clearCache(): void {
    this.cache.clear();
  }

  // Get cache stats
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.cache.size,
      keys: Array.from(this.cache.keys()).map(k => k.slice(0, 8) + '...')
    };
  }

  // Simplified method for scenario-driven agents to synthesize tool results
  async synthesizeToolResult(toolName: string, parameters: Record<string, any>, toolDefinition: any): Promise<any> {
    // For testing purposes, create a simple result
    // In a real implementation, this would use the LLM to generate realistic results
    const isTerminal = /Success$|Approval$|Failure$|Denial$|NoSlots$/.test(toolName);
    
    if (isTerminal) {
      return {
        success: true,
        action: toolName,
        message: `Successfully executed ${toolName}`,
        terminal: true
      };
    } else {
      return {
        success: true,
        action: toolName,
        data: parameters,
        message: `Executed ${toolName} with parameters: ${JSON.stringify(parameters)}`
      };
    }
  }
}