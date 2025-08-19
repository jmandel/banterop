// src/server/bridge/hono-node-adapters.ts
//
// Adapters to bridge between Hono's request/response model and Node.js-style streams
// that the MCP SDK expects.
//

import type { Context } from 'hono';
import { Readable, Writable } from 'stream';

// StatusCode is a union type, we'll just use number for now
type StatusCode = number;

/**
 * Adapter that makes a Hono Context look like a Node.js IncomingMessage
 */
export class HonoIncomingMessage extends Readable {
  headers: Record<string, string | string[] | undefined>;
  method: string;
  url: string;
  
  constructor(ctx: Context, body: any) {
    super();
    this.headers = Object.fromEntries(ctx.req.raw.headers.entries());
    this.method = ctx.req.method;
    // Use full URL for better fidelity with Node IncomingMessage expectations
    this.url = ctx.req.url;
    
    // Push body and signal end
    if (body) {
      this.push(JSON.stringify(body));
    }
    this.push(null);
  }
  
  _read() {
    // No-op - we push data in constructor
  }
}

/**
 * Adapter that captures Node.js ServerResponse writes and applies them to Hono Context
 */
export class HonoServerResponse extends Writable {
  statusCode: StatusCode = 200;
  private headers: Record<string, string> = {};
  private chunks: Buffer[] = [];
  
  constructor(private ctx: Context) {
    super();
  }
  
  setHeader(name: string, value: string): void {
    this.headers[name.toLowerCase()] = value;
  }
  
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
  
  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode as StatusCode;
    if (headers) {
      Object.entries(headers).forEach(([k, v]) => {
        this.headers[k.toLowerCase()] = v;
      });
    }
    return this;
  }

  // Some libraries chain writeHead(...).flushHeaders() to send headers early for streaming.
  // In this adapter, we capture headers and status and apply them when the response finalizes.
  // Providing a no-op flushHeaders() keeps compatibility with such code paths.
  flushHeaders(): void {
    // no-op: headers are buffered and applied in _final()
  }
  
  // Override end() to match Node.js Writable signature
  end(cb?: () => void): this;
  end(chunk: any, cb?: () => void): this;
  end(chunk: any, encoding: BufferEncoding, cb?: () => void): this;
  end(chunkOrCb?: any, encodingOrCb?: any, cb?: () => void): this {
    if (typeof chunkOrCb === 'function') {
      // end(cb)
      super.end(chunkOrCb);
    } else if (chunkOrCb !== undefined) {
      if (typeof encodingOrCb === 'function') {
        // end(chunk, cb)
        this.write(chunkOrCb);
        super.end(encodingOrCb);
      } else if (typeof encodingOrCb === 'string') {
        // end(chunk, encoding, cb)
        this.write(chunkOrCb, encodingOrCb as BufferEncoding);
        super.end(cb);
      } else {
        // end(chunk)
        this.write(chunkOrCb);
        super.end();
      }
    } else {
      // end()
      super.end();
    }
    return this;
  }
  
  _write(chunk: any, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding));
    callback();
  }
  
  async _final(callback: (error?: Error | null) => void): Promise<void> {
    const body = Buffer.concat(this.chunks).toString('utf8');
    
    // Apply headers to context
    Object.entries(this.headers).forEach(([k, v]) => {
      this.ctx.header(k, v);
    });
    
    // Set status and body - Hono's status() accepts numbers
    (this.ctx.status as (code: number) => void)(this.statusCode);
    
    const contentType = this.headers['content-type'];
    if (contentType?.includes('application/json')) {
      try {
        const jsonBody = body ? JSON.parse(body) : {};
        this.ctx.res = Response.json(jsonBody, {
          status: this.statusCode,
          headers: this.headers as HeadersInit,
        });
      } catch {
        this.ctx.res = new Response(body, {
          status: this.statusCode,
          headers: this.headers as HeadersInit,
        });
      }
    } else {
      this.ctx.res = new Response(body, {
        status: this.statusCode,
        headers: this.headers as HeadersInit,
      });
    }
    
    callback();
  }
}
