import assert from 'node:assert/strict';
import net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { startServer } from '../server.js';
import type { AdminHandler } from './mount.js';

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

test('startServer consults the admin handler for every path except the exact health routes', async () => {
  const seen: string[] = [];
  let closed = 0;
  const admin: AdminHandler = {
    handle(request, response) {
      seen.push(request.url ?? '');
      if (request.url !== '/api/v1/status') return false;
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
      return true;
    },
    loginUrl: () => null,
    rotateLoginUrl: () => '',
    close: async () => { closed += 1; }
  };
  const port = await freePort();
  const running = await startServer({ port, database: null }, { admin });
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/v1/status`)).status, 200);
    assert.equal((await fetch(`http://127.0.0.1:${port}/livez`)).status, 200);
    const declined = await fetch(`http://127.0.0.1:${port}/livez/`);
    assert.equal(declined.status, 404);
    assert.deepEqual(await declined.json(), { status: 'not_found' });
    assert.equal((await fetch(`http://127.0.0.1:${port}/readyz?x=1`)).status, 404);
    assert.deepEqual(seen, ['/api/v1/status', '/livez/', '/readyz?x=1']);
  } finally {
    await running.stop();
    await running.stop();
  }
  assert.equal(closed, 1, 'stop() closes the admin handler once');
});

test('a throwing admin handler yields a generic 500 and the server keeps serving', async () => {
  const admin: AdminHandler = {
    handle() { throw new Error('boom secret'); },
    loginUrl: () => null, rotateLoginUrl: () => '', close: async () => {}
  };
  const port = await freePort();
  const running = await startServer({ port, database: null }, { admin });
  try {
    const failed = await fetch(`http://127.0.0.1:${port}/api/v1/x`);
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /boom|secret/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/livez`)).status, 200);
  } finally {
    await running.stop();
  }
});
