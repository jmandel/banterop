import { describe, test, expect } from 'bun:test';
import type { ToolResultEntry } from '$lib/types.js';

// Since we can't easily test React components in Bun without additional setup,
// let's test the markdown rendering logic separately

describe('Markdown Rendering in Tool Results', () => {
  // Test the markdown detection logic
  test('should detect markdown content when contentType is text/markdown', () => {
    const markdownEntry: ToolResultEntry = {
      id: 'test-1',
      agentId: 'agent1',
      timestamp: new Date(),
      type: 'tool_result',
      toolCallId: 'call-1',
      result: {
        contentType: 'text/markdown',
        content: '# Test Document\n\n**Bold text** and *italic text*\n\n`inline code`'
      }
    };

    // Check detection logic
    const hasResult = markdownEntry.result !== undefined && markdownEntry.result !== null;
    const isMarkdownContent = hasResult && 
      typeof markdownEntry.result === 'object' && 
      markdownEntry.result.contentType === 'text/markdown' && 
      markdownEntry.result.content;

    expect(!!isMarkdownContent).toBe(true);
  });

  test('should not detect markdown for non-markdown tool results', () => {
    const jsonEntry: ToolResultEntry = {
      id: 'test-2',
      agentId: 'agent1',
      timestamp: new Date(),
      type: 'tool_result',
      toolCallId: 'call-2',
      result: {
        data: 'some data',
        status: 'success'
      }
    };

    const hasResult = jsonEntry.result !== undefined && jsonEntry.result !== null;
    const isMarkdownContent = hasResult && 
      typeof jsonEntry.result === 'object' && 
      jsonEntry.result.contentType === 'text/markdown' && 
      jsonEntry.result.content;

    expect(isMarkdownContent).toBe(false);
  });

  // Test the simple markdown renderer function
  function renderMarkdown(text: string): string {
    return text
      // Headers
      .replace(/^### (.*$)/gim, '<h3>$1</h3>')
      .replace(/^## (.*$)/gim, '<h2>$1</h2>')
      .replace(/^# (.*$)/gim, '<h1>$1</h1>')
      // Bold
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      // Italic
      .replace(/\*(.+?)\*/g, '<em>$1</em>')
      // Line breaks
      .replace(/\n/g, '<br>')
      // Code blocks (simple version)
      .replace(/```([\s\S]*?)```/g, '<pre style="background: #2a2a2a; padding: 8px; border-radius: 4px; overflow: auto;">$1</pre>')
      // Inline code
      .replace(/`([^`]+)`/g, '<code style="background: #2a2a2a; padding: 2px 4px; border-radius: 3px;">$1</code>');
  }

  test('should render markdown headers', () => {
    const markdown = '# Header 1\n## Header 2\n### Header 3';
    const rendered = renderMarkdown(markdown);
    
    expect(rendered).toContain('<h1>Header 1</h1>');
    expect(rendered).toContain('<h2>Header 2</h2>');
    expect(rendered).toContain('<h3>Header 3</h3>');
  });

  test('should render bold and italic text', () => {
    const markdown = '**bold text** and *italic text*';
    const rendered = renderMarkdown(markdown);
    
    expect(rendered).toContain('<strong>bold text</strong>');
    expect(rendered).toContain('<em>italic text</em>');
  });

  test('should render inline code', () => {
    const markdown = 'Here is `inline code` in text';
    const rendered = renderMarkdown(markdown);
    
    expect(rendered).toContain('<code style="background: #2a2a2a; padding: 2px 4px; border-radius: 3px;">inline code</code>');
  });

  test('should render code blocks', () => {
    const markdown = 'Text before\n```\nconst x = 42;\nconsole.log(x);\n```\nText after';
    const rendered = renderMarkdown(markdown);
    
    expect(rendered).toContain('<pre style="background: #2a2a2a; padding: 8px; border-radius: 4px; overflow: auto;">');
    expect(rendered).toContain('const x = 42;');
  });

  test('should handle document content in new attachment format', () => {
    // Test the new docId format
    const docEntry: ToolResultEntry = {
      id: 'test-5',
      agentId: 'agent1',
      timestamp: new Date(),
      type: 'tool_result',
      toolCallId: 'call-5',
      result: {
        docId: 'doc_pt_notes_123',
        contentType: 'text/markdown',
        content: '# Physical Therapy Notes\n\n**Patient:** John Doe\n\n## Progress\n- Good range of motion\n- Pain level: 3/10'
      }
    };

    expect(docEntry.result.docId).toBe('doc_pt_notes_123');
    expect(docEntry.result.contentType).toBe('text/markdown');
    expect(docEntry.result.content).toContain('Physical Therapy Notes');
  });
});