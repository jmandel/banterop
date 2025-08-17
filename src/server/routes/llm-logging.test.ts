import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { Hono } from 'hono';
import { createLLMRoutes } from './llm.http';
import { LLMProviderManager } from '$src/llm/provider-manager';
import { existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('LLM Logging with Metadata', () => {
  const testLogDir = '/tmp/llm-debug-test';
  let app: Hono;
  let pm: LLMProviderManager;

  beforeAll(() => {
    // Set up test environment
    process.env.DEBUG_LLM_REQUESTS = 'true';
    process.env.LLM_DEBUG_DIR = testLogDir;
    process.env.LLM_PROVIDER = 'mock';
    
    // Clean up any existing test directory
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true });
    }

    // Create provider manager with mock as default
    pm = new LLMProviderManager({ 
      defaultLlmProvider: 'mock',
      defaultLlmModel: 'mock-model'
    });
    const llmRoutes = createLLMRoutes(pm);
    app = new Hono();
    app.route('/', llmRoutes);
  });

  afterAll(() => {
    // Clean up
    if (existsSync(testLogDir)) {
      rmSync(testLogDir, { recursive: true, force: true });
    }
    delete process.env.DEBUG_LLM_REQUESTS;
    delete process.env.LLM_DEBUG_DIR;
    delete process.env.LLM_PROVIDER;
  });

  it('creates conversation folder with timestamped turn logs', async () => {
    const request = {
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello!' }
      ],
      loggingMetadata: {
        conversationId: 'test-conv-123',
        agentName: 'assistant',
        turnNumber: 1,
        stepDescriptor: 'initial'
      }
    };

    const res = await app.request('/llm/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    expect(res.status).toBe(200);

    // Check that conversation folder was created
    const convDir = join(testLogDir, 'conversation_test-conv-123');
    expect(existsSync(convDir)).toBe(true);

    // List files in conversation directory
    const files = Bun.file(convDir).type;
    console.log('Created conversation directory:', convDir);

    // Find the created log directory (timestamp will vary)
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(convDir);
    expect(entries.length).toBeGreaterThan(0);

    // Check the naming pattern
    const logDir = entries[0] as string;
    expect(logDir).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/); // Starts with timestamp
    expect(logDir).toContain('_turn_001_assistant_initial');

    // Check files were created
    const logPath = join(convDir, logDir);
    expect(existsSync(join(logPath, 'request.txt'))).toBe(true);
    expect(existsSync(join(logPath, 'response.txt'))).toBe(true);
    expect(existsSync(join(logPath, 'metadata.json'))).toBe(true);

    // Verify metadata content
    const metadata = JSON.parse(readFileSync(join(logPath, 'metadata.json'), 'utf-8'));
    expect(metadata.conversationId).toBe('test-conv-123');
    expect(metadata.agentName).toBe('assistant');
    expect(metadata.turnNumber).toBe(1);
    expect(metadata.stepDescriptor).toBe('initial');
  });

  it('creates tool synthesis logs within conversation folder', async () => {
    const request = {
      messages: [
        { role: 'user', content: 'Synthesize tool response' }
      ],
      loggingMetadata: {
        conversationId: 'test-conv-456',
        agentName: 'tool_synthesis',
        stepDescriptor: 'synthesize_search_weather'
      }
    };

    const res = await app.request('/llm/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    expect(res.status).toBe(200);

    // Check that conversation folder was created
    const convDir = join(testLogDir, 'conversation_test-conv-456');
    expect(existsSync(convDir)).toBe(true);

    // Find the created log directory
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(convDir);
    expect(entries.length).toBeGreaterThan(0);

    const logDir = entries[0];
    // Should start with timestamp and include tool synthesis info
    expect(logDir).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    expect(logDir).toContain('_tool_synthesis_synthesize_search_weather');
  });

  it('creates scenario editor logs in flat structure', async () => {
    const request = {
      messages: [
        { role: 'user', content: 'Create a scenario' }
      ],
      loggingMetadata: {
        scenarioId: 'weather-app',
        stepDescriptor: 'create_initial'
      }
    };

    const res = await app.request('/llm/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    expect(res.status).toBe(200);

    // Check that scenario_editor folder was created
    const editorDir = join(testLogDir, 'scenario_editor');
    expect(existsSync(editorDir)).toBe(true);

    // Find the created log directory
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(editorDir);
    expect(entries.length).toBeGreaterThan(0);

    const logDir = entries[0] as string;
    // Should start with timestamp for chronological sorting
    expect(logDir).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    expect(logDir).toContain('_weather-app_create_initial');
    
    // Check that it's a directory with the standard files
    const logPath = join(editorDir, logDir);
    expect(existsSync(join(logPath, 'request.txt'))).toBe(true);
    expect(existsSync(join(logPath, 'response.txt'))).toBe(true);
    expect(existsSync(join(logPath, 'metadata.json'))).toBe(true);
  });

  it('maintains chronological order within conversation', async () => {
    const convId = 'test-conv-order';  // Use unique ID to avoid conflicts
    
    // Simulate multiple calls in sequence
    const requests = [
      {
        messages: [{ role: 'user', content: 'First message' }],
        loggingMetadata: {
          conversationId: convId,
          agentName: 'assistant',
          turnNumber: 1,
          stepDescriptor: 'initial'
        }
      },
      {
        messages: [{ role: 'user', content: 'Tool synthesis' }],
        loggingMetadata: {
          conversationId: convId,
          agentName: 'tool_synthesis',
          stepDescriptor: 'synthesize_tool'
        }
      },
      {
        messages: [{ role: 'user', content: 'Second turn' }],
        loggingMetadata: {
          conversationId: convId,
          agentName: 'assistant',
          turnNumber: 2,
          stepDescriptor: 'response'
        }
      }
    ];

    // Send requests with small delays to ensure different timestamps
    for (const req of requests) {
      await app.request('/llm/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(req)
      });
      await new Promise(resolve => setTimeout(resolve, 10)); // Small delay
    }

    // Check chronological ordering
    const convDir = join(testLogDir, `conversation_${convId}`);
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(convDir).sort();

    expect(entries.length).toBe(3);
    
    // All entries should start with timestamp and be in order
    entries.forEach(entry => {
      expect(entry).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}/);
    });

    // Check that entries contain expected identifiers
    expect(entries[0]).toContain('_turn_001_assistant_initial');
    expect(entries[1]).toContain('_tool_synthesis_synthesize_tool');
    expect(entries[2]).toContain('_turn_002_assistant_response');
  });

  it('handles missing metadata gracefully', async () => {
    const request = {
      messages: [{ role: 'user', content: 'No metadata' }]
    };

    const res = await app.request('/llm/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    expect(res.status).toBe(200);

    // Should create in untagged folder
    const untaggedDir = join(testLogDir, 'untagged');
    expect(existsSync(untaggedDir)).toBe(true);
  });

  it('sanitizes path components to prevent directory traversal', async () => {
    // Test various malicious path patterns
    const maliciousRequests = [
      {
        conversationId: '../../../etc/passwd',
        expectedDir: 'conversation_______etc_passwd'  // 3x".." + 4x"/" = 7 underscores
      },
      {
        conversationId: '..\\..\\windows\\system32',
        expectedDir: 'conversation_____windows_system32'  // 2x".." + 3x"\" = 5 underscores
      },
      {
        conversationId: 'test/../../../evil',
        expectedDir: 'conversation_test_______evil'  // "test" + "/" + 3x".." + 3x"/" = 7 underscores
      },
      {
        conversationId: 'test\0null',
        expectedDir: 'conversation_testnull'
      }
    ];

    for (const { conversationId, expectedDir } of maliciousRequests) {
      const request = {
        messages: [{ role: 'user', content: 'Test' }],
        loggingMetadata: {
          conversationId,
          agentName: '../evil',
          turnNumber: 1,
          stepDescriptor: '../../hack'
        }
      };

      const res = await app.request('/llm/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
      });

      expect(res.status).toBe(200);

      // Check that the sanitized directory was created within the test directory
      const convDir = join(testLogDir, expectedDir);
      expect(existsSync(convDir)).toBe(true);

      // Verify no files were created outside the test directory
      expect(existsSync('/etc/passwd.request.txt')).toBe(false);
      expect(existsSync('../../evil')).toBe(false);
    }
  });

  it('ensures all created paths are within the logging directory', async () => {
    // Test that our path validation works by checking created directories
    const request = {
      messages: [{ role: 'user', content: 'Test' }],
      loggingMetadata: {
        conversationId: 'safe-test',
        agentName: 'test-agent',
        stepDescriptor: 'validation'
      }
    };

    const res = await app.request('/llm/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    expect(res.status).toBe(200);

    // Verify that files are only created within the test directory
    const { readdirSync, statSync } = await import('node:fs');
    const { resolve } = await import('node:path');
    const testDirContents = readdirSync(testLogDir);
    const resolvedTestDir = resolve(testLogDir);
    
    // Check that all created entries are within the test directory
    for (const entry of testDirContents) {
      const fullPath = resolve(join(testLogDir, entry));
      // Ensure the resolved path starts with the test directory path
      expect(fullPath.startsWith(resolvedTestDir)).toBe(true);
      
      // If it's a directory, check its contents too
      if (statSync(fullPath).isDirectory()) {
        const subEntries = readdirSync(fullPath);
        for (const subEntry of subEntries) {
          const subPath = resolve(join(fullPath, subEntry));
          expect(subPath.startsWith(resolvedTestDir)).toBe(true);
        }
      }
    }
    
    // Verify no files were created outside the test directory
    // (by checking parent directory doesn't have new unexpected files)
    const parentDir = resolve(join(testLogDir, '..'));
    expect(existsSync(join(parentDir, 'request.txt'))).toBe(false);
    expect(existsSync(join(parentDir, 'response.txt'))).toBe(false);
  });

  it('sanitizes agent names and step descriptors', async () => {
    const request = {
      messages: [{ role: 'user', content: 'Test' }],
      loggingMetadata: {
        conversationId: 'safe-conv',
        agentName: '../../malicious/agent',
        turnNumber: 1,
        stepDescriptor: '../../../etc/sensitive'
      }
    };

    const res = await app.request('/llm/complete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    expect(res.status).toBe(200);

    // Check the created directory
    const convDir = join(testLogDir, 'conversation_safe-conv');
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(convDir);
    
    expect(entries.length).toBe(1);
    const logDir = entries[0];
    
    // Should sanitize the agent name and step descriptor
    expect(logDir).toContain('___malicious_agent');
    expect(logDir).toContain('____etc_sensitive');
    
    // Should not contain any parent directory references
    expect(logDir).not.toContain('..');
    expect(logDir).not.toContain('/');
    expect(logDir).not.toContain('\\');
  });
});