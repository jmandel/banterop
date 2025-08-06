// Unit tests for ToolParser
import { test, expect, describe } from 'bun:test';
import { 
  parseToolsFromResponse, 
  hasToolCalls, 
  extractToolNames, 
  validateToolName,
  parseToolCalls 
} from '../../src/lib/utils/tool-parser.js';

describe('ToolParser', () => {

  test('should parse a single tool call in a ```json code block', () => {
    const output = 'My reasoning.\n```json\n{"name": "test_tool", "args": {"p1": 1}}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.message).toBe('My reasoning.');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('test_tool');
    expect(result.tools[0].args.p1).toBe(1);
  });

  test('should handle text after the JSON block', () => {
    const output = 'I need to search first.\n```json\n{"name": "search", "args": {"query": "test"}}\n```\nSome text after.';
    const result = parseToolsFromResponse(output);
    
    expect(result.message).toBe('I need to search first.');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('search');
    expect(result.tools[0].args.query).toBe('test');
  });

  test('should parse from a generic ``` code block', () => {
    const output = 'Let me call the API.\n```\n{"name": "api_call", "args": {"endpoint": "/users"}}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.message).toBe('Let me call the API.');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('api_call');
    expect(result.tools[0].args.endpoint).toBe('/users');
  });

  test('should return empty tools array if no valid tool is found', () => {
    const output = 'Just some regular text without any tool calls.';
    const result = parseToolsFromResponse(output);
    
    expect(result.message).toBe('Just some regular text without any tool calls.');
    expect(result.tools).toHaveLength(0);
  });

  test('should handle malformed JSON gracefully and fall back', () => {
    const output = 'Bad JSON:\n```json\n{"name": "test", "args": {invalid\n```\nBut good inline: {"name": "fallback", "args": {}}';
    const result = parseToolsFromResponse(output);
    
    // Should fall back to legacy parsing and find the inline tool
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('fallback');
  });

  test('should parse legacy inline tool calls', () => {
    const output = 'I need to {"name": "legacy_tool", "args": {"test": true}} now';
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('legacy_tool');
    expect(result.tools[0].args.test).toBe(true);
    expect(result.message).toBe('I need to  now');
  });

  test('should handle tolerant JSON parsing with unquoted keys', () => {
    const output = 'Testing:\n```json\n{name: "unquoted_test", args: {key: "value"}}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('unquoted_test');
    expect(result.tools[0].args.key).toBe('value');
  });

  test('should handle single quotes in JSON', () => {
    const output = "Testing:\n```json\n{'name': 'single_quote_test', 'args': {'key': 'value'}}\n```";
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('single_quote_test');
    expect(result.tools[0].args.key).toBe('value');
  });

  test('should handle trailing commas', () => {
    const output = 'Testing:\n```json\n{"name": "trailing_comma_test", "args": {"key": "value",}}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('trailing_comma_test');
    expect(result.tools[0].args.key).toBe('value');
  });

  test('should validate tool names properly', () => {
    expect(validateToolName('valid_tool')).toBe(true);
    expect(validateToolName('valid123')).toBe(true);
    expect(validateToolName('_private')).toBe(true);
    expect(validateToolName('invalid-tool')).toBe(false);
    expect(validateToolName('invalid.tool')).toBe(false);
    expect(validateToolName('123invalid')).toBe(false);
    expect(validateToolName('')).toBe(false);
  });

  test('should detect if response has tool calls', () => {
    const withTool = 'Testing ```json\n{"name": "test", "args": {}}\n```';
    const withoutTool = 'Just regular text';
    
    expect(hasToolCalls(withTool)).toBe(true);
    expect(hasToolCalls(withoutTool)).toBe(false);
  });

  test('should extract tool names', () => {
    const output = 'Testing ```json\n{"name": "first_tool", "args": {}}\n```';
    const toolNames = extractToolNames(output);
    
    expect(toolNames).toHaveLength(1);
    expect(toolNames[0]).toBe('first_tool');
  });

  test('should handle missing args property', () => {
    const output = 'Testing ```json\n{"name": "no_args_tool"}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('no_args_tool');
    expect(result.tools[0].args).toEqual({});
  });

  test('should use the last JSON block when multiple exist', () => {
    const output = 'First: ```json\n{"name": "first", "args": {}}\n```\nSecond: ```json\n{"name": "second", "args": {}}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('second');
    expect(result.message).toBe('First: ```json\n{"name": "first", "args": {}}\n```\nSecond:');
  });

  test('should reject invalid tool objects', () => {
    const output = 'Bad tool: ```json\n{"invalid": "object"}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(0);
    expect(result.message).toBe('Bad tool: ```json\n{"invalid": "object"}\n```');
  });

  test('parseToolCalls convenience function', () => {
    const output = 'Testing ```json\n{"name": "test_tool", "args": {"param": "value"}}\n```';
    const result = parseToolCalls(output);
    
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      tool: 'test_tool',
      parameters: { param: 'value' }
    });
  });

  test('should extract content from scratchpad tags', () => {
    const output = '<scratchpad>\nThis is my reasoning about the problem.\nI need to analyze the data.\n</scratchpad>\n```json\n{"name": "analyze", "args": {"data": "test"}}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.message).toBe('This is my reasoning about the problem.\nI need to analyze the data.');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('analyze');
  });

  test('should handle content without scratchpad tags', () => {
    const output = 'Direct reasoning without tags.\n```json\n{"name": "process", "args": {}}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.message).toBe('Direct reasoning without tags.');
    expect(result.tools).toHaveLength(1);
  });

  test('should handle missing closing brace in JSON block', () => {
    const output = '<scratchpad>\nI need to send a message with attachments.\n</scratchpad>\n```json\n{\n  "name": "send_message_to_agent_conversation",\n  "args": {\n    "text": "Hello, here is the documentation.",\n    "attachments_to_include": [\n      "policy_HF-MRI-KNEE-2024"\n    ]\n  }\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.message).toBe('I need to send a message with attachments.');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('send_message_to_agent_conversation');
    expect(result.tools[0].args.text).toBe('Hello, here is the documentation.');
    expect(result.tools[0].args.attachments_to_include).toEqual(['policy_HF-MRI-KNEE-2024']);
  });

  test('should handle missing closing bracket in array', () => {
    const output = '```json\n{"name": "test_tool", "args": {"items": ["item1", "item2"}}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('test_tool');
    expect(result.tools[0].args.items).toEqual(['item1', 'item2']);
  });

  test('should handle multi-line text fields with missing closing brace', () => {
    const output = `<scratchpad>
I have successfully retrieved the full medical policy for an MRI of the knee (docId: policy_HF-MRI-KNEE-2024).
</scratchpad>
\`\`\`json
{
  "name": "send_message_to_agent_conversation",
  "args": {
    "text": "Hello Jordan Alvarez (Member ID: HF8901234567),\\n\\nThank you for your inquiry regarding the prior authorization request for a right knee MRI.\\n\\n**Documentation required:**\\n1. Physician Order for the MRI\\n2. Initial Injury Report\\n3. Physical Therapy Progress Notes\\n\\nPlease submit all documents within this conversation thread.\\n\\nRegards,\\nPrior Authorization Specialist",
    "attachments_to_include": [
      "policy_HF-MRI-KNEE-2024"
    ]
  }
\`\`\``;
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('send_message_to_agent_conversation');
    expect(result.tools[0].args.text).toContain('Hello Jordan Alvarez');
    expect(result.tools[0].args.attachments_to_include).toEqual(['policy_HF-MRI-KNEE-2024']);
  });

  test('should handle missing multiple closing braces', () => {
    const output = '```json\n{"name": "nested", "args": {"level1": {"level2": {"value": "test"}\n```';
    const result = parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('nested');
    expect(result.tools[0].args.level1.level2.value).toBe('test');
  });
});