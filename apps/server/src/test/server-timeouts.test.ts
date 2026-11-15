// Request timeouts: Node's single 300 s requestTimeout is replaced by an idle timeout for long evidence
// uploads and a total body deadline for every other request (slowloris protection stays).
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { test } from 'node:test';
import type { AdminHandler } from '../admin/mount.js';
import { isEvidenceUploadRequest } from '../evidence/routes.js';
import { startServer } from '../server.js';

/** Reads the whole body, then answers with its length. */
function countingAdmin(): AdminHandler {
  return {
    handle(request: IncomingMessage, response: ServerResponse) {
      let bytes = 0;
      request.on('data', (chunk: Buffer) => { bytes += chunk.length; });
      request.on('end', () => { const text = String(bytes); response.writeHead(200, { 'Content-Type': 'text/plain', 'Content-Length': text.length }); response.end(text); });
      return true;
    },
    loginUrl: () => null,
    rotateLoginUrl: () => '',
    close: async () => {}
  } as unknown as AdminHandler;
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Sends headers, then `chunks` bytes `gapMs` apart; resolves with the response text or 'closed'. */
function dribble(port: number, path: string, contentType: string, chunks: number, gapMs: number, stallAfter = Infinity): Promise<string> {
  return new Promise(resolve => {
    const socket = net.connect(port, '127.0.0.1');
    let text = '';
    socket.on('data', data => { text += data.toString('latin1'); });
    socket.on('error', () => {});
    socket.on('close', () => resolve(text || 'closed'));
    socket.on('connect', async () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: ${contentType}\r\n`
        + `Content-Length: ${chunks}\r\nConnection: close\r\n\r\n`);
      for (let i = 0; i < chunks; i++) {
        if (i >= stallAfter) return;   // Stop sending; the server must hang up.
        await sleep(gapMs);
        if (socket.destroyed) return;
        socket.write('x');
      }
    });
  });
}

const UPLOAD = '/api/v1/events/11111111-1111-4111-8111-111111111111/matches/M1/evidence';

test('upload detection: only POSTs of a non-JSON body to a match evidence path', () => {
  const request = (method: string, url: string, type?: string) =>
    ({ method, url, headers: type ? { 'content-type': type } : {} }) as IncomingMessage;
  assert.equal(isEvidenceUploadRequest(request('POST', UPLOAD, 'video/mp4')), true);
  assert.equal(isEvidenceUploadRequest(request('POST', `${UPLOAD}?note=x`, 'video/mp4')), true);
  assert.equal(isEvidenceUploadRequest(request('POST', UPLOAD, 'application/json; charset=utf-8')), false);
  assert.equal(isEvidenceUploadRequest(request('POST', UPLOAD)), false);
  assert.equal(isEvidenceUploadRequest(request('GET', UPLOAD, 'video/mp4')), false);
  assert.equal(isEvidenceUploadRequest(request('POST', '/api/v1/events/x/snapshot', 'video/mp4')), false);
});

test('a long upload that keeps sending outlives the body deadline; a stalled one is cut by the idle timeout', async () => {
  const running = await startServer({ port: 0, database: null },
    { admin: countingAdmin(), timeouts: { bodyMs: 300, uploadIdleMs: 250, headersMs: 1_000 } });
  try {
    // 12 bytes, 60 ms apart: ~720 ms in total, well past bodyMs, never idle for uploadIdleMs.
    const slow = await dribble(running.port, UPLOAD, 'video/mp4', 12, 60);
    assert.match(slow, /^HTTP\/1\.1 200/);
    assert.match(slow, /\r\n\r\n12$/);
    // Stops after 2 bytes: the idle timeout closes the connection without an answer.
    const started = Date.now();
    assert.equal(await dribble(running.port, UPLOAD, 'video/mp4', 10, 20, 2), 'closed');
    assert.ok(Date.now() - started < 2_000);
  } finally { await running.stop(); }
});

test('ordinary requests keep a total body deadline (slowloris guard)', async () => {
  const running = await startServer({ port: 0, database: null },
    { admin: countingAdmin(), timeouts: { bodyMs: 300, uploadIdleMs: 10_000, headersMs: 1_000 } });
  try {
    // A JSON body dribbled for ~720 ms is cut at bodyMs even though it never goes idle.
    assert.equal(await dribble(running.port, '/api/v1/session', 'application/json', 12, 60), 'closed');
    // A quick one is answered.
    assert.match(await dribble(running.port, '/api/v1/session', 'application/json', 2, 5), /\r\n\r\n2$/);
  } finally { await running.stop(); }
});

test('a long-lived GET (the console event stream) is not cut by the body deadline', async () => {
  // Answers GETs with a stream that writes a line every 50 ms and never ends on its own.
  const timers = new Set<NodeJS.Timeout>();
  const admin = {
    handle(_request: IncomingMessage, response: ServerResponse) {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const timer = setInterval(() => response.write('data: tick\n\n'), 50);
      timers.add(timer);
      response.on('close', () => { clearInterval(timer); timers.delete(timer); });
      return true;
    },
    loginUrl: () => null, rotateLoginUrl: () => '', close: async () => {}
  } as unknown as AdminHandler;
  const running = await startServer({ port: 0, database: null }, { admin, timeouts: { bodyMs: 200, uploadIdleMs: 200, headersMs: 1_000 } });
  try {
    const result = await new Promise<{ ticks: number; open: boolean }>(resolve => {
      const socket = net.connect(running.port, '127.0.0.1');
      let text = '';
      let open = true;
      socket.on('data', data => { text += data.toString('latin1'); });
      socket.on('error', () => {});
      socket.on('close', () => { open = false; });
      socket.on('connect', () => socket.write(`GET /api/v1/stream HTTP/1.1\r\nHost: 127.0.0.1:${running.port}\r\n\r\n`));
      setTimeout(() => { resolve({ ticks: text.split('data: tick').length - 1, open }); socket.destroy(); }, 900);
    });
    assert.equal(result.open, true, 'the stream outlives bodyMs');
    assert.ok(result.ticks >= 10, `the stream kept flowing (${result.ticks} events)`);
  } finally {
    for (const timer of timers) clearInterval(timer);
    await running.stop();
  }
});
