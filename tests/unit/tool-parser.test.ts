// Unit tests for ToolParser
import { test, expect, describe } from 'bun:test';
import { ToolParser } from '../../src/lib/utils/tool-parser.js';

describe('ToolParser', () => {
  const parser = new ToolParser();

  test('should parse a single tool call in a ```json code block', () => {
    const output = 'My reasoning.\n```json\n{"name": "test_tool", "args": {"p1": 1}}\n```';
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.message).toBe('My reasoning.');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('test_tool');
    expect(result.tools[0].args.p1).toBe(1);
  });

  test('should handle text after the JSON block', () => {
    const output = 'I need to search first.\n```json\n{"name": "search", "args": {"query": "test"}}\n```\nSome text after.';
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.message).toBe('I need to search first.');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('search');
    expect(result.tools[0].args.query).toBe('test');
  });

  test('should parse from a generic ``` code block', () => {
    const output = 'Let me call the API.\n```\n{"name": "api_call", "args": {"endpoint": "/users"}}\n```';
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.message).toBe('Let me call the API.');
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('api_call');
    expect(result.tools[0].args.endpoint).toBe('/users');
  });

  test('should return empty tools array if no valid tool is found', () => {
    const output = 'Just some regular text without any tool calls.';
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.message).toBe('Just some regular text without any tool calls.');
    expect(result.tools).toHaveLength(0);
  });

  test('should handle malformed JSON gracefully and fall back', () => {
    const output = 'Bad JSON:\n```json\n{"name": "test", "args": {invalid\n```\nBut good inline: {"name": "fallback", "args": {}}';
    const result = parser.parseToolsFromResponse(output);
    
    // Should fall back to legacy parsing and find the inline tool
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('fallback');
  });

  test('should parse legacy inline tool calls', () => {
    const output = 'I need to {"name": "legacy_tool", "args": {"test": true}} now';
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('legacy_tool');
    expect(result.tools[0].args.test).toBe(true);
    expect(result.message).toBe('I need to  now');
  });

  test('should handle tolerant JSON parsing with unquoted keys', () => {
    const output = 'Testing:\n```json\n{name: "unquoted_test", args: {key: "value"}}\n```';
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('unquoted_test');
    expect(result.tools[0].args.key).toBe('value');
  });

  test('should handle single quotes in JSON', () => {
    const output = "Testing:\n```json\n{'name': 'single_quote_test', 'args': {'key': 'value'}}\n```";
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('single_quote_test');
    expect(result.tools[0].args.key).toBe('value');
  });

  test('should handle trailing commas', () => {
    const output = 'Testing:\n```json\n{"name": "trailing_comma_test", "args": {"key": "value",}}\n```';
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('trailing_comma_test');
    expect(result.tools[0].args.key).toBe('value');
  });

  test('should validate tool names properly', () => {
    expect(parser.validateToolName('valid_tool')).toBe(true);
    expect(parser.validateToolName('valid123')).toBe(true);
    expect(parser.validateToolName('_private')).toBe(true);
    expect(parser.validateToolName('invalid-tool')).toBe(false);
    expect(parser.validateToolName('invalid.tool')).toBe(false);
    expect(parser.validateToolName('123invalid')).toBe(false);
    expect(parser.validateToolName('')).toBe(false);
  });

  test('should detect if response has tool calls', () => {
    const withTool = 'Testing ```json\n{"name": "test", "args": {}}\n```';
    const withoutTool = 'Just regular text';
    
    expect(parser.hasToolCalls(withTool)).toBe(true);
    expect(parser.hasToolCalls(withoutTool)).toBe(false);
  });

  test('should extract tool names', () => {
    const output = 'Testing ```json\n{"name": "first_tool", "args": {}}\n```';
    const toolNames = parser.extractToolNames(output);
    
    expect(toolNames).toHaveLength(1);
    expect(toolNames[0]).toBe('first_tool');
  });

  test('should handle missing args property', () => {
    const output = 'Testing ```json\n{"name": "no_args_tool"}\n```';
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('no_args_tool');
    expect(result.tools[0].args).toEqual({});
  });

  test('should use the last JSON block when multiple exist', () => {
    const output = 'First: ```json\n{"name": "first", "args": {}}\n```\nSecond: ```json\n{"name": "second", "args": {}}\n```';
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(1);
    expect(result.tools[0].name).toBe('second');
    expect(result.message).toBe('First: ```json\n{"name": "first", "args": {}}\n```\nSecond:');
  });

  test('should reject invalid tool objects', () => {
    const output = 'Bad tool: ```json\n{"invalid": "object"}\n```';
    const result = parser.parseToolsFromResponse(output);
    
    expect(result.tools).toHaveLength(0);
    expect(result.message).toBe('Bad tool: ```json\n{"invalid": "object"}\n```');
  });
});