// Tool Parser for extracting tool calls from LLM responses
// Uses simple JSON structure: {"name": "toolName", "args": {...}}

export interface ToolCall {
  name: string;
  args: Record<string, any>;
  rawMatch: string;
}

export interface ParsedResponse {
  message: string;
  tools: ToolCall[];
}

/**
 * Parse tool calls from LLM response using new scratchpad + JSON block format (Task 1.3)
 * Supports multiple formats in priority order:
 * 1. ```json ... ``` code blocks (preferred)
 * 2. ``` ... ``` generic code blocks containing JSON tool calls
 * 3. Inline JSON objects (legacy fallback)
 * 
 * All text before the code block is treated as reasoning/scratchpad
 * 
 * Examples:
 * - "I need to check the patient's records first.\n```json\n{\"name\": \"searchRecords\", \"args\": {\"query\": \"diabetes\"}}\n```"
 * - "Let me search.\n```\n{\"name\": \"searchRecords\", \"args\": {}}\n```"
 * - "Quick search {\"name\": \"searchRecords\", \"args\": {\"query\": \"test\"}}"
 */
export function parseToolsFromResponse(llmOutput: string): ParsedResponse {
    // Find the last occurrence of a ```json ... ``` block
    const jsonBlockMatch = findLastJsonCodeBlock(llmOutput);
    
    if (jsonBlockMatch) {
      try {
        // Parse the JSON with tolerant parsing
        const parsed = parseTolerantJSON(jsonBlockMatch.content);
        
        // Validate it looks like a tool call
        if (isValidToolCall(parsed)) {
          const toolCall: ToolCall = {
            name: parsed.name,
            args: parsed.args || {},
            rawMatch: jsonBlockMatch.fullMatch
          };
          
          // Everything before the JSON block is the reasoning/scratchpad
          let reasoning = llmOutput.substring(0, jsonBlockMatch.start).trim();
          
          // Extract content from <scratchpad> tags if present
          const scratchpadMatch = reasoning.match(/<scratchpad>\s*([\s\S]*?)\s*<\/scratchpad>/);
          if (scratchpadMatch) {
            reasoning = scratchpadMatch[1].trim();
          }
          
          return {
            message: reasoning,
            tools: [toolCall]
          };
        }
      } catch (error) {
        console.warn(`Failed to parse JSON block: ${jsonBlockMatch.content.slice(0, 100)}...`);
        console.warn(`Parse error: ${error instanceof Error ? error.message : error}`);
      }
    }
    
    // Fallback to legacy parsing for backward compatibility
    return parseToolsFromResponseLegacy(llmOutput);
  }

/**
 * Parse tool calls from LLM response containing JSON tool call objects (legacy method)
 * Looks for objects with structure: {"name": "toolName", "args": {...}}
 * 
 * Examples:
 * - {"name": "searchRecords", "args": {"query": "diabetes"}}
 * - {"name": "no_response_needed", "args": {}}
 * - {name: 'sendMessage', args: {text: 'Hello', urgent: true}} // tolerant parsing
 */
function parseToolsFromResponseLegacy(llmOutput: string): ParsedResponse {
    let remainingText = llmOutput;
    
    // Find potential JSON objects that contain "name" property
    const matches = findToolCallCandidates(llmOutput);
    
    // Return the FIRST valid tool call only (single-action constraint)
    for (const match of matches) {
      try {
        // Parse the JSON with tolerant parsing
        const parsed = parseTolerantJSON(match.content);
        
        // Validate it looks like a tool call
        if (isValidToolCall(parsed)) {
          const toolCall: ToolCall = {
            name: parsed.name,
            args: parsed.args || {},
            rawMatch: match.content
          };
          
          // Remove tool call from text
          remainingText = remainingText.replace(match.content, '');
          
          // Return immediately with first valid tool (single-action)
          return {
            message: remainingText.trim(),
            tools: [toolCall]
          };
        }
      } catch (error) {
        // If parsing fails, log the error and skip this candidate
        console.warn(`Failed to parse tool call candidate: ${match.content.slice(0, 100)}...`);
        console.warn(`Parse error: ${error instanceof Error ? error.message : error}`);
        continue;
      }
    }
    
    // No valid tools found
    return {
      message: remainingText.trim(),
      tools: []
    };
  }
  
/**
 * Find the last occurrence of a code block (```json or ``` without language)
 */
function findLastJsonCodeBlock(text: string): {content: string, start: number, end: number, fullMatch: string} | null {
    // First try to find ```json blocks
    const jsonBlockRegex = /```json\s*([\s\S]*?)\s*```/gi;
    let lastMatch: {content: string, start: number, end: number, fullMatch: string} | null = null;
    let match;
    
    while ((match = jsonBlockRegex.exec(text)) !== null) {
      lastMatch = {
        content: match[1]!.trim(), // Regex group 1 always exists in this match
        start: match.index,
        end: match.index + match[0].length,
        fullMatch: match[0]
      };
    }
    
    // If no ```json blocks found, try generic ``` blocks
    if (!lastMatch) {
      const genericBlockRegex = /```\s*([\s\S]*?)\s*```/gi;
      
      while ((match = genericBlockRegex.exec(text)) !== null) {
        const blockContent = match[1]!.trim(); // Regex group 1 always exists
        // Only consider blocks that look like JSON (start with { and contain "name")
        if (blockContent.startsWith('{') && (blockContent.includes('"name"') || blockContent.includes("'name'") || /\bname\s*:/.test(blockContent))) {
          lastMatch = {
            content: blockContent,
            start: match.index,
            end: match.index + match[0].length,
            fullMatch: match[0]
          };
        }
      }
    }
    
    return lastMatch;
  }

/**
 * Find potential tool call JSON objects in the text
 * Uses a more sophisticated approach than simple regex
 */
function findToolCallCandidates(text: string): Array<{content: string, start: number, end: number}> {
    const candidates: Array<{content: string, start: number, end: number}> = [];
    
    // Look for opening braces
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') {
        // Try to find the matching closing brace
        const jsonStr = extractJSONObject(text, i);
        if (jsonStr && (jsonStr.includes('"name"') || jsonStr.includes("'name'") || /\bname\s*:/.test(jsonStr))) {
          candidates.push({
            content: jsonStr,
            start: i,
            end: i + jsonStr.length
          });
        }
      }
    }
    
    return candidates;
  }
  
/**
 * Extract a complete JSON object starting from a given position
 */
function extractJSONObject(text: string, startPos: number): string | null {
    let braceCount = 0;
    let inString = false;
    let escapeNext = false;
    let start = startPos;
    
    for (let i = startPos; i < text.length; i++) {
      const char = text[i];
      
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        continue;
      }
      
      if (char === '"' && !escapeNext) {
        inString = !inString;
        continue;
      }
      
      if (!inString) {
        if (char === '{') {
          braceCount++;
        } else if (char === '}') {
          braceCount--;
          if (braceCount === 0) {
            // Found complete JSON object
            return text.substring(start, i + 1);
          }
        }
      }
    }
    
    return null; // Incomplete JSON
  }
  
/**
 * Check if parsed object looks like a valid tool call
 */
function isValidToolCall(obj: any): obj is {name: string, args?: Record<string, any>} {
    return obj && 
           typeof obj === 'object' && 
           typeof obj.name === 'string' && 
           obj.name.length > 0 &&
           validateToolName(obj.name);
  }
  
/**
 * Tolerant JSON parser that handles common LLM issues:
 * - JavaScript-style comments (// and block comments)
 * - Trailing commas
 * - Unquoted property names
 * - Single quotes
 * - Missing closing braces/brackets
 */
function parseTolerantJSON(jsonStr: string): any {
    try {
      // Try standard JSON first
      return JSON.parse(jsonStr);
    } catch (firstError) {
      // Fall back to tolerant parsing
      let cleaned = jsonStr.trim();
      
      // Remove JavaScript-style comments
      cleaned = removeComments(cleaned);
      
      // Fix trailing commas
      cleaned = fixTrailingCommas(cleaned);
      
      // Fix unquoted property names
      cleaned = fixUnquotedKeys(cleaned);
      
      // Convert single quotes to double quotes
      cleaned = fixSingleQuotes(cleaned);
      
      try {
        return JSON.parse(cleaned);
      } catch (secondError) {
        // Try rescue heuristics for missing closing braces/brackets
        const rescued = applyRescueHeuristics(cleaned);
        if (rescued !== cleaned) {
          try {
            return JSON.parse(rescued);
          } catch (rescueError) {
            // If rescue also fails, throw the original error
            throw firstError;
          }
        }
        throw firstError;
      }
    }
  }
  
/**
 * Apply rescue heuristics to fix common JSON structure issues
 */
function applyRescueHeuristics(jsonStr: string): string {
  // First, try a smarter approach: balance the JSON by inserting missing brackets/braces
  // in the right positions
  const smartFixed = smartBalanceJSON(jsonStr);
  if (smartFixed !== jsonStr) {
    try {
      JSON.parse(smartFixed);
      return smartFixed;
    } catch {
      // Smart fix didn't work, fall back to simple approach
    }
  }
  
  // Simple approach: just append missing brackets/braces at the end
  // Count opening and closing braces/brackets
  let openBraces = 0;
  let closeBraces = 0;
  let openBrackets = 0;
  let closeBrackets = 0;
  let inString = false;
  let escapeNext = false;
  
  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    
    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      continue;
    }
    
    if (char === '"' && !escapeNext) {
      inString = !inString;
      continue;
    }
    
    if (!inString) {
      if (char === '{') openBraces++;
      else if (char === '}') closeBraces++;
      else if (char === '[') openBrackets++;
      else if (char === ']') closeBrackets++;
    }
  }
  
  // Add missing closing brackets first, then braces
  const missingBrackets = openBrackets - closeBrackets;
  const missingBraces = openBraces - closeBraces;
  
  let fixed = jsonStr;
  if (missingBrackets > 0) {
    fixed += ']'.repeat(missingBrackets);
  }
  if (missingBraces > 0) {
    fixed += '}'.repeat(missingBraces);
  }
  
  return fixed;
}

/**
 * Smart JSON balancing - tries to insert missing brackets/braces in contextually appropriate places
 */
function smartBalanceJSON(jsonStr: string): string {
  // For the common case of arrays missing closing brackets before object closes
  // e.g., ["item1", "item2"}} -> ["item1", "item2"]}}
  
  // Track the stack of open structures
  const stack: ('array' | 'object')[] = [];
  let result = '';
  let inString = false;
  let escapeNext = false;
  
  for (let i = 0; i < jsonStr.length; i++) {
    const char = jsonStr[i];
    
    if (escapeNext) {
      escapeNext = false;
      result += char;
      continue;
    }
    
    if (char === '\\') {
      escapeNext = true;
      result += char;
      continue;
    }
    
    if (char === '"' && !escapeNext) {
      inString = !inString;
      result += char;
      continue;
    }
    
    if (!inString) {
      if (char === '[') {
        stack.push('array');
        result += char;
      } else if (char === '{') {
        stack.push('object');
        result += char;
      } else if (char === ']') {
        if (stack[stack.length - 1] === 'array') {
          stack.pop();
        }
        result += char;
      } else if (char === '}') {
        // Check if we have an unclosed array that should be closed here
        if (stack[stack.length - 1] === 'array' && stack[stack.length - 2] === 'object') {
          // We're trying to close an object but have an unclosed array
          result += ']'; // Close the array first
          stack.pop(); // Remove array from stack
        }
        if (stack[stack.length - 1] === 'object') {
          stack.pop();
        }
        result += char;
      } else {
        result += char;
      }
    } else {
      result += char;
    }
  }
  
  // Add any remaining closes
  while (stack.length > 0) {
    const structure = stack.pop();
    if (structure === 'array') {
      result += ']';
    } else {
      result += '}';
    }
  }
  
  return result;
}

/**
 * Remove JavaScript-style comments
 */
function removeComments(str: string): string {
    // Remove /* */ style comments
    str = str.replace(/\/\*[\s\S]*?\*\//g, '');
    
    // Remove // style comments (but not in strings)
    const lines = str.split('\n');
    const cleanedLines = lines.map(line => {
      let inString = false;
      let escapeNext = false;
      let result = '';
      
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        
        if (escapeNext) {
          result += char;
          escapeNext = false;
          continue;
        }
        
        if (char === '\\') {
          escapeNext = true;
          result += char;
          continue;
        }
        
        if (char === '"' && !escapeNext) {
          inString = !inString;
        }
        
        if (!inString && char === '/' && line[i + 1] === '/') {
          break; // Rest of line is comment
        }
        
        result += char;
      }
      
      return result;
    });
    
    return cleanedLines.join('\n');
  }
  
/**
 * Fix trailing commas
 */
function fixTrailingCommas(str: string): string {
    return str.replace(/,(\s*[}\]])/g, '$1');
  }
  
/**
 * Fix unquoted property names
 */
function fixUnquotedKeys(str: string): string {
    return str.replace(/([{,]\s*)([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:/g, '$1"$2":');
  }
  
/**
 * Convert single quotes to double quotes
 */
function fixSingleQuotes(str: string): string {
    let result = '';
    let inSingleQuote = false;
    let inDoubleQuote = false;
    let escapeNext = false;
    
    for (let i = 0; i < str.length; i++) {
      const char = str[i];
      
      if (escapeNext) {
        result += char;
        escapeNext = false;
        continue;
      }
      
      if (char === '\\') {
        escapeNext = true;
        result += char;
        continue;
      }
      
      if (char === '"' && !inSingleQuote) {
        inDoubleQuote = !inDoubleQuote;
        result += char;
      } else if (char === "'" && !inDoubleQuote) {
        inSingleQuote = !inSingleQuote;
        result += '"'; // Convert single quote to double quote
      } else {
        result += char;
      }
    }
    
    return result;
  }
  
/**
 * Check if response contains any tool calls
 */
export function hasToolCalls(llmOutput: string): boolean {
  const parsed = parseToolsFromResponse(llmOutput);
  return parsed.tools.length > 0;
}
  
/**
 * Extract just tool names from response (for quick analysis)
 */
export function extractToolNames(llmOutput: string): string[] {
  const parsed = parseToolsFromResponse(llmOutput);
  return parsed.tools.map(t => t.name);
}
  
/**
 * Validate that tool name is safe (no special characters)
 */
export function validateToolName(toolName: string): boolean {
  return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(toolName);
}

// Convenience function for simple tool call parsing
export function parseToolCalls(text: string): any[] {
  const result = parseToolsFromResponse(text);
  return result.tools.map(tool => ({
    tool: tool.name,
    parameters: tool.args
  }));
}