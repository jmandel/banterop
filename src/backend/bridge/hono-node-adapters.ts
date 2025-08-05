/**
 * Adapters to bridge between Hono's Web API and Node.js HTTP interfaces
 * for compatibility with StreamableHTTPServerTransport
 */

import { Context } from 'hono';
import { Readable, Writable } from 'stream';
import { EventEmitter } from 'events';

/**
 * Convert Web API Headers to Node.js style headers object
 * Node.js uses lowercase header names
 */
export function headersToObject(headers: Headers): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {};
  headers.forEach((value, key) => {
    const lowerKey = key.toLowerCase();
    if (result[lowerKey]) {
      // Handle multiple header values
      if (Array.isArray(result[lowerKey])) {
        (result[lowerKey] as string[]).push(value);
      } else {
        result[lowerKey] = [result[lowerKey] as string, value];
      }
    } else {
      result[lowerKey] = value;
    }
  });
  return result;
}

/**
 * Convert Web Streams API ReadableStream to Node.js Readable stream
 */
export function readableFromWeb(webStream: ReadableStream<Uint8Array> | null): Readable {
  if (!webStream) {
    // Return empty readable stream
    return Readable.from([]);
  }

  const reader = webStream.getReader();
  
  return new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) {
          this.push(null); // Signal end of stream
        } else {
          this.push(Buffer.from(value));
        }
      } catch (error) {
        this.destroy(error as Error);
      }
    },
    
    destroy(error, callback) {
      reader.releaseLock();
      callback(error);
    }
  });
}

/**
 * Adapter for IncomingMessage that works with Hono's Context
 */
export class HonoIncomingMessage extends Readable {
  public method: string;
  public url: string;
  public headers: Record<string, string | string[]>;
  public httpVersion: string = '1.1';
  public auth?: any;
  
  private bodyStream: Readable;
  private parsedBody: any;
  
  constructor(c: Context, parsedBody?: any) {
    super();
    
    this.method = c.req.method;
    this.url = new URL(c.req.url).pathname + (new URL(c.req.url).search || '');
    this.headers = headersToObject(c.req.raw.headers);
    this.parsedBody = parsedBody;
    
    // If we have a pre-parsed body, create a stream from it
    if (parsedBody !== null && parsedBody !== undefined) {
      const bodyString = JSON.stringify(parsedBody);
      const bodyBuffer = Buffer.from(bodyString, 'utf8');
      this.bodyStream = Readable.from([bodyBuffer]);
    } else {
      // Convert body stream for GET requests or when no body
      this.bodyStream = readableFromWeb(c.req.raw.body);
    }
    
    // Pipe the body stream through this
    this.bodyStream.on('data', (chunk) => this.push(chunk));
    this.bodyStream.on('end', () => this.push(null));
    this.bodyStream.on('error', (err) => this.destroy(err));
    
    // Optional: attach auth info if available from middleware
    // this.auth = c.get('auth');
  }
  
  // Override read to delegate to bodyStream
  _read(size: number): void {
    // Reading is handled by piping from bodyStream
  }
}

/**
 * Buffered ServerResponse adapter for JSON responses
 */
export class HonoServerResponse extends EventEmitter {
  private c: Context;
  private statusCode: number = 200;
  private headers: Record<string, string> = {};
  private chunks: Buffer[] = [];
  private ended: boolean = false;
  public headersSent: boolean = false;
  
  constructor(c: Context) {
    super();
    this.c = c;
  }
  
  writeHead(statusCode: number, headers?: Record<string, string>): this {
    console.log('[HonoServerResponse] writeHead called with status:', statusCode, 'headers:', headers);
    this.statusCode = statusCode;
    if (headers) {
      // Normalize header names to lowercase to avoid duplicates
      Object.entries(headers).forEach(([key, value]) => {
        this.headers[key.toLowerCase()] = value;
      });
    }
    // Ensure Content-Type is set if not already specified
    if (!this.headers['content-type']) {
      this.headers['content-type'] = 'application/json';
    }
    console.log('[HonoServerResponse] Final headers after writeHead:', this.headers);
    this.headersSent = true;
    
    // Check if this is SSE based on Content-Type
    if (this.headers['content-type'] === 'text/event-stream') {
      // Switch to SSE mode - start a Hono stream
      this.startSSEStream();
    }
    
    return this;
  }
  
  private startSSEStream(): void {
    console.log('[HonoServerResponse] Starting SSE stream mode');
    // Start streaming with Hono
    this.c.stream(async (stream) => {
      // Store the writer for SSE writes
      (this as any).sseWriter = stream.writer;
      
      // Wait for the stream to end
      await new Promise<void>((resolve) => {
        this.once('_sse_end', resolve);
      });
    });
  }
  
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
  
  write(chunk: any, encoding?: any, callback?: any): boolean {
    if (this.ended) {
      throw new Error('Cannot write after end');
    }
    
    const cb = typeof encoding === 'function' ? encoding : callback;
    
    // Check if we're in SSE mode
    const sseWriter = (this as any).sseWriter;
    if (sseWriter) {
      // In SSE mode, write directly to the stream
      let data: Uint8Array;
      if (chunk instanceof Uint8Array) {
        data = chunk;
      } else if (Buffer.isBuffer(chunk)) {
        data = new Uint8Array(chunk);
      } else if (typeof chunk === 'string') {
        const encoder = new TextEncoder();
        data = encoder.encode(chunk);
      } else {
        const encoder = new TextEncoder();
        data = encoder.encode(String(chunk));
      }
      
      sseWriter.write(data).then(() => {
        if (cb) cb();
      }).catch((err: any) => {
        if (cb) cb(err);
      });
      
      return true;
    }
    
    // Regular buffered mode
    let buffer: Buffer;
    if (Buffer.isBuffer(chunk)) {
      buffer = chunk;
    } else if (typeof chunk === 'string') {
      buffer = Buffer.from(chunk, typeof encoding === 'string' ? encoding : 'utf8');
    } else {
      buffer = Buffer.from(String(chunk));
    }
    
    this.chunks.push(buffer);
    
    if (cb) {
      process.nextTick(cb);
    }
    
    return true; // Always return true for buffered response
  }
  
  end(chunk?: any, encoding?: any, callback?: any): this {
    if (this.ended) {
      return this;
    }
    
    // Handle various parameter combinations
    let cb = callback;
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = undefined;
    } else if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    
    if (chunk !== undefined) {
      this.write(chunk, encoding);
    }
    
    this.ended = true;
    
    // Check if we're in SSE mode
    const sseWriter = (this as any).sseWriter;
    if (sseWriter) {
      // In SSE mode, close the stream
      sseWriter.close().then(() => {
        this.emit('_sse_end');
        this.emit('close');
        if (cb) cb();
      }).catch((err: any) => {
        this.emit('_sse_end');
        this.emit('close');
        if (cb) cb(err);
      });
      return this;
    }
    
    // Regular buffered mode
    // Combine all chunks
    const body = Buffer.concat(this.chunks);
    
    // Ensure Content-Type is set for JSON responses
    if (!this.headers['content-type']) {
      this.headers['content-type'] = 'application/json';
    }
    
    console.log('[HonoServerResponse] end() setting response with:');
    console.log('  Status:', this.statusCode);
    console.log('  Headers:', this.headers);
    console.log('  Body length:', body.length);
    
    // Set the response in Hono
    this.c.res = new Response(body, {
      status: this.statusCode,
      headers: this.headers
    });
    
    // Emit close event
    process.nextTick(() => {
      this.emit('close');
      if (cb) cb();
    });
    
    return this;
  }
  
  flushHeaders(): void {
    // If we're in SSE mode and headers haven't been sent yet
    if (this.headers['content-type'] === 'text/event-stream' && !this.headersSent) {
      this.writeHead(this.statusCode);
    }
    this.headersSent = true;
  }
  
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
}

/**
 * SSE ServerResponse adapter for streaming responses
 */
export class HonoSSEServerResponse extends EventEmitter {
  private c: Context;
  private statusCode: number = 200;
  private headers: Record<string, string> = {};
  private streamController: ReadableStreamDefaultController<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private ended: boolean = false;
  public headersSent: boolean = false;
  
  constructor(c: Context) {
    super();
    this.c = c;
    
    // Listen for client disconnect
    if (this.c.req.raw.signal) {
      this.c.req.raw.signal.addEventListener('abort', () => {
        this.handleClose();
      });
    }
  }
  
  writeHead(statusCode: number, headers?: Record<string, string>): this {
    this.statusCode = statusCode;
    if (headers) {
      Object.assign(this.headers, headers);
    }
    return this;
  }
  
  setHeader(name: string, value: string): this {
    this.headers[name.toLowerCase()] = value;
    return this;
  }
  
  getHeader(name: string): string | undefined {
    return this.headers[name.toLowerCase()];
  }
  
  flushHeaders(): void {
    if (this.headersSent || this.ended) {
      return;
    }
    
    this.headersSent = true;
    
    // Set SSE headers
    const sseHeaders = {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      ...this.headers
    };
    
    // If we already have a writer (set externally for Hono stream), just set headers
    if (this.writer) {
      // Headers are already set by the parent stream context
      return;
    }
    
    // Otherwise, start streaming with Hono (legacy path, shouldn't be used)
    this.c.header('Content-Type', 'text/event-stream');
    this.c.header('Cache-Control', 'no-cache');
    this.c.header('Connection', 'keep-alive');
    
    Object.entries(sseHeaders).forEach(([key, value]) => {
      this.c.header(key, value);
    });
    
    // Create a streaming response
    const stream = this.c.stream(async (stream) => {
      this.writer = stream.writer;
      
      // Keep the stream open until explicitly ended
      await new Promise<void>((resolve) => {
        this.once('_internal_end', resolve);
      });
    });
  }
  
  write(chunk: any, encoding?: any, callback?: any): boolean {
    if (this.ended) {
      throw new Error('Cannot write after end');
    }
    
    const cb = typeof encoding === 'function' ? encoding : callback;
    
    // Ensure headers are sent
    if (!this.headersSent) {
      this.flushHeaders();
    }
    
    // Convert chunk to Uint8Array
    let data: Uint8Array;
    if (chunk instanceof Uint8Array) {
      data = chunk;
    } else if (Buffer.isBuffer(chunk)) {
      data = new Uint8Array(chunk);
    } else if (typeof chunk === 'string') {
      const encoder = new TextEncoder();
      data = encoder.encode(chunk);
    } else {
      const encoder = new TextEncoder();
      data = encoder.encode(String(chunk));
    }
    
    // Write to stream if writer is available
    if (this.writer) {
      this.writer.write(data).then(() => {
        if (cb) cb();
      }).catch((err) => {
        if (cb) cb(err);
      });
    } else {
      // Queue the write until stream is ready
      process.nextTick(() => {
        if (this.writer) {
          this.writer.write(data).then(() => {
            if (cb) cb();
          }).catch((err) => {
            if (cb) cb(err);
          });
        } else if (cb) {
          cb(new Error('Stream not ready'));
        }
      });
    }
    
    return true;
  }
  
  end(chunk?: any, encoding?: any, callback?: any): this {
    if (this.ended) {
      return this;
    }
    
    // Handle various parameter combinations
    let cb = callback;
    if (typeof chunk === 'function') {
      cb = chunk;
      chunk = undefined;
    } else if (typeof encoding === 'function') {
      cb = encoding;
      encoding = undefined;
    }
    
    if (chunk !== undefined) {
      this.write(chunk, encoding);
    }
    
    this.ended = true;
    
    // Close the stream
    if (this.writer) {
      this.writer.close().then(() => {
        this.emit('_internal_end');
        this.handleClose();
        if (cb) cb();
      }).catch((err) => {
        this.emit('_internal_end');
        this.handleClose();
        if (cb) cb(err);
      });
    } else {
      process.nextTick(() => {
        this.emit('_internal_end');
        this.handleClose();
        if (cb) cb();
      });
    }
    
    return this;
  }
  
  private handleClose(): void {
    if (!this.ended) {
      this.ended = true;
      this.emit('_internal_end');
    }
    this.emit('close');
  }
  
  status(code: number): this {
    this.statusCode = code;
    return this;
  }
}

/**
 * Helper function to determine if request should use SSE
 */
export function shouldUseSSE(c: Context): boolean {
  // GET requests with Accept: text/event-stream should use SSE
  if (c.req.method === 'GET') {
    const accept = c.req.header('Accept');
    return accept?.includes('text/event-stream') === true;
  }
  return false;
}