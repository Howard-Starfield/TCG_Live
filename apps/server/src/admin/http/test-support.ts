// Shared helpers for the admin HTTP tests: a real startServer() with the admin handler, and raw HTTP clients.
import assert from 'node:assert/strict';
import { once } from 'node:events';
import http, { type IncomingHttpHeaders } from 'node:http';
import net from 'node:net';
import type { StreamEventDto } from '@tcg-live/core';
import { startServer, type RunningServer } from '../../server.js';
import type { AdminHandlerOptions } from '../mount.js';
import { createAdminHttp, type AdminHttp, type AdminHttpInternals } from './handler.js';
import { StubRuntime } from './test-runtime.js';

export async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

export interface Harness {
  port: number;
  runtime: StubRuntime;
  admin: AdminHttp;
  server: RunningServer;
  printed: string[];
  launchToken(): string;
  stop(): Promise<void>;
}

export async function startHarness(
  options: Partial<Omit<AdminHandlerOptions, 'port' | 'runtime'>> = {},
  internals: AdminHttpInternals = {},
  runtime = new StubRuntime()
): Promise<Harness> {
  const port = await freePort();
  const printed: string[] = [];
  const admin = createAdminHttp({
    runtime, port, mode: 'demo', commandsEnabled: true, printLoginUrl: url => { printed.push(url); }, ...options
  }, { timings: { pingMs: 60_000, heartbeatMs: 60_000, versionCheckMs: 60_000 }, ...internals });
  const server = await startServer({ port, database: null }, { admin });
  return {
    port, runtime, admin, server, printed,
    launchToken: () => admin.loginUrl()!.split('#login=')[1]!,
    stop: () => server.stop()
  };
}

export interface Reply { status: number; headers: IncomingHttpHeaders; text: string; json(): any }

export interface CallOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  token?: string;
  /** Sends the served origin unless false or overridden in headers. */
  origin?: boolean;
}

export function call(port: number, path: string, options: CallOptions = {}): Promise<Reply> {
  const method = options.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (options.origin !== false && method !== 'GET' && method !== 'HEAD') headers.Origin = `http://127.0.0.1:${port}`;
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = String(Buffer.byteLength(options.body));
  }
  Object.assign(headers, options.headers);
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path, method, headers, agent: false }, response => {
      const chunks: Buffer[] = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({ status: response.statusCode ?? 0, headers: response.headers, text, json: () => JSON.parse(text) });
      });
      response.on('error', reject);
    });
    request.on('error', reject);
    request.setTimeout(5_000, () => request.destroy(new Error('request timed out')));
    request.end(options.body);
  });
}

export async function login(harness: Harness): Promise<string> {
  const reply = await call(harness.port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token: harness.launchToken() }) });
  assert.equal(reply.status, 200, reply.text);
  return reply.json().token;
}

export interface StreamFrame { event?: string; id?: string; data?: StreamEventDto; comment?: string }

export interface StreamClient {
  status: number;
  headers: IncomingHttpHeaders;
  /** The next frame, or a rejection after `timeoutMs`. */
  next(timeoutMs?: number): Promise<StreamFrame>;
  /** Next frame that is an event of `type`, skipping comments and other events. */
  nextEvent<T extends StreamEventDto['type']>(type: T, timeoutMs?: number): Promise<Extract<StreamEventDto, { type: T }> & { id?: string }>;
  /** Frames received but not yet consumed. */
  pending(): StreamFrame[];
  ended: Promise<void>;
  close(): void;
}

function parseFrame(block: string): StreamFrame {
  const frame: StreamFrame = {};
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) frame.comment = line.slice(1).trim();
    else if (line.startsWith('event: ')) frame.event = line.slice(7);
    else if (line.startsWith('id: ')) frame.id = line.slice(4);
    else if (line.startsWith('data: ')) frame.data = JSON.parse(line.slice(6));
  }
  return frame;
}

export function openStream(port: number, token: string | null, headers: Record<string, string> = {}): Promise<StreamClient> {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: '127.0.0.1', port, path: '/api/v1/stream', method: 'GET', agent: false,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }
    }, response => {
      const frames: StreamFrame[] = [];
      const waiters: (() => void)[] = [];
      let buffer = '';
      let done = false;
      const wake = () => { for (const waiter of waiters.splice(0)) waiter(); };
      const ended = new Promise<void>(resolveEnded => {
        response.on('end', () => { done = true; wake(); resolveEnded(); });
        response.on('close', () => { done = true; wake(); resolveEnded(); });
        response.on('error', () => { done = true; wake(); resolveEnded(); });
      });
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        buffer += chunk;
        let split: number;
        while ((split = buffer.indexOf('\n\n')) !== -1) {
          frames.push(parseFrame(buffer.slice(0, split)));
          buffer = buffer.slice(split + 2);
        }
        wake();
      });
      const next = (timeoutMs = 2_000): Promise<StreamFrame> => new Promise((resolveNext, rejectNext) => {
        const attempt = () => {
          const frame = frames.shift();
          if (frame) {
            clearTimeout(timer);
            resolveNext(frame);
          } else if (done) {
            clearTimeout(timer);
            rejectNext(new Error('stream ended'));
          } else waiters.push(attempt);
        };
        const timer = setTimeout(() => rejectNext(new Error('timed out waiting for a stream frame')), timeoutMs);
        attempt();
      });
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        next,
        async nextEvent(type, timeoutMs = 2_000) {
          const deadline = Date.now() + timeoutMs;
          for (;;) {
            const frame = await next(Math.max(1, deadline - Date.now()));
            if (frame.data?.type === type) return { ...frame.data, id: frame.id } as any;
          }
        },
        pending: () => [...frames],
        ended,
        close: () => request.destroy()
      });
    });
    request.on('error', reject);
    request.end();
  });
}

export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Polls `check` until it holds, failing after `timeoutMs`. */
export async function waitFor(check: () => boolean | Promise<boolean>, label: string, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await delay(10);
  }
}
