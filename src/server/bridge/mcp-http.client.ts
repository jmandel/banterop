// src/server/bridge/mcp-http.client.ts
// MCP client using @modelcontextprotocol/sdk with Streamable HTTP transport only.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export type McpClientOptions = {
  baseUrl: string;               // e.g., http://host/api/bridge/:config64/mcp
  headers?: Record<string, string>;
  timeoutMs?: number;            // optional per-request timeout (unused by SDK directly)
};

export class RemoteMcpHttpClient {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private connecting = false;

  constructor(private opts: McpClientOptions) {}

  private async ensureConnected(): Promise<void> {
    if (this.client) return;
    if (this.connecting) {
      // naive wait-loop; avoid double-connect
      while (this.connecting) await new Promise(r => setTimeout(r, 10));
      return;
    }
    this.connecting = true;
    try {
      this.client = new Client({ name: 'mcp-proxy-client', version: '1.0.0' });
      const url = new URL(this.opts.baseUrl);
      this.transport = new StreamableHTTPClientTransport(url, {
        requestInit: {
          headers: this.opts.headers,
        },
      });
      await this.client.connect(this.transport);
    } finally {
      this.connecting = false;
    }
  }

  private async callTool<T = any>(name: string, args: any): Promise<T> {
    await this.ensureConnected();
    const result: any = await this.client!.callTool({ name, arguments: args } as any);
    const text = result?.content?.[0]?.text;
    if (typeof text !== 'string') throw new Error('Invalid MCP response payload');
    return JSON.parse(text) as T;
  }

  async beginChatThread(): Promise<{ conversationId: string }> {
    return this.callTool('begin_chat_thread', {});
  }

  async sendMessage(params: { conversationId: string; message: string; attachments?: Array<{ name: string; contentType: string; content: string; summary?: string; docId?: string }> }): Promise<{ ok: true; guidance?: string; status?: string }> {
    return this.callTool('send_message_to_chat_thread', params);
  }

  async checkReplies(params: { conversationId: string; waitMs?: number; max?: number }): Promise<{ messages: any[]; guidance: string; status: string; conversation_ended: boolean }> {
    return this.callTool('check_replies', params);
  }
}
