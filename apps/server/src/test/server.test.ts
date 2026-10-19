import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CONFIG_ERROR, parseDatabaseUrl } from '../config.js';
import { startServer } from '../server.js';

const mainPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../main.js');
const credential = 'SyntheticPasswordB0';

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

async function get(port: number, route: string, method = 'GET'): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${route}`, { method });
}

test('URL grammar accepts one explicit loopback target and rejects overrides', () => {
  assert.equal(parseDatabaseUrl(undefined), null);
  assert.equal(parseDatabaseUrl(' \t '), null);
  assert.deepEqual(parseDatabaseUrl('postgres://alice:password@localhost:5432/tcg_live'), {
    host: 'localhost', port: 5432, database: 'tcg_live', user: 'alice', password: 'password'
  });
  assert.equal(parseDatabaseUrl('postgresql://alice:password@[::1]:5432/tcg_live')?.host, '::1');
  for (const value of [
    'http://alice:password@localhost:5432/tcg_live',
    'postgres://alice:password@example.com:5432/tcg_live',
    'postgres://alice:password@localhost,example.com:5432/tcg_live',
    'postgres://alice:password@localhost:5432/tcg_live?host=example.com',
    'postgres://alice:password@localhost:5432/tcg_live?sslmode=require',
    'postgres://alice:password@localhost:5432/tcg_live#fragment',
    'postgres://alice:password@localhost:5432/',
    'postgres://alice:password@localhost/tcg_live',
    'postgres://alice@localhost:5432/tcg_live',
    'postgres://alice:password@localhost:5432/tcg_live/other',
    'not a url'
  ]) {
    assert.throws(() => parseDatabaseUrl(value), { message: CONFIG_ERROR });
  }
});

test('disconnected health contract, method handling, and exact paths', async () => {
  const port = await freePort();
  const running = await startServer({ port, database: null });
  try {
    const live = await get(port, '/livez');
    assert.equal(live.status, 200);
    assert.deepEqual(await live.json(), { status: 'live' });
    const ready = await get(port, '/readyz');
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'not_configured' });
    const method = await get(port, '/readyz', 'POST');
    assert.equal(method.status, 405);
    assert.equal(method.headers.get('allow'), 'GET');
    assert.deepEqual(await method.json(), { status: 'method_not_allowed' });
    const unknown = await get(port, '/livez/');
    assert.equal(unknown.status, 404);
    assert.deepEqual(await unknown.json(), { status: 'not_found' });
    assert.equal((await get(port, '/readyz?x=1')).status, 404);
  } finally {
    await running.stop();
  }
});

test('port collision is actionable and listener stays on IPv4 loopback', async () => {
  const port = await freePort();
  const first = await startServer({ port, database: null });
  try {
    await assert.rejects(startServer({ port, database: null }), /PORT is already in use on 127\.0\.0\.1/);
    await assert.rejects(fetch(`http://[::1]:${port}/livez`));
  } finally {
    await first.stop();
  }
});

test('refused database gives unavailable while liveness stays available', async () => {
  const dbPort = await freePort();
  const port = await freePort();
  const database = parseDatabaseUrl(`postgres://alice:${credential}@127.0.0.1:${dbPort}/tcg_live`);
  assert(database);
  const running = await startServer({ port, database });
  try {
    const ready = await get(port, '/readyz');
    assert.equal(ready.status, 503);
    assert.deepEqual(await ready.json(), { status: 'unavailable' });
    assert.deepEqual(await (await get(port, '/livez')).json(), { status: 'live' });
  } finally {
    await running.stop();
  }
});

test('stalled PG handshake is bounded, coalesced, retryable, and does not block liveness', async () => {
  const sockets = new Set<net.Socket>();
  let accepted = 0;
  const stalled = net.createServer(socket => {
    accepted += 1;
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  stalled.listen(0, '127.0.0.1');
  await once(stalled, 'listening');
  const address = stalled.address();
  assert(address && typeof address !== 'string');
  const port = await freePort();
  const database = parseDatabaseUrl(`postgres://alice:${credential}@127.0.0.1:${address.port}/tcg_live`);
  assert(database);
  const running = await startServer({ port, database });
  try {
    const started = Date.now();
    const pending = Array.from({ length: 8 }, () => get(port, '/readyz'));
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.deepEqual(await (await get(port, '/livez')).json(), { status: 'live' });
    const responses = await Promise.all(pending);
    assert(responses.every(response => response.status === 503));
    assert(Date.now() - started < 2_800);
    assert.equal(accepted, 1);
    assert.equal((await get(port, '/readyz')).status, 503);
    assert.equal(accepted, 2);
  } finally {
    await running.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => stalled.close(() => resolve()));
  }
});

test('stop is idempotent with pending probe and open request; port can be reused', async () => {
  const sockets = new Set<net.Socket>();
  const stalled = net.createServer(socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  stalled.listen(0, '127.0.0.1');
  await once(stalled, 'listening');
  const address = stalled.address();
  assert(address && typeof address !== 'string');
  const port = await freePort();
  const database = parseDatabaseUrl(`postgres://alice:${credential}@127.0.0.1:${address.port}/tcg_live`);
  assert(database);
  const running = await startServer({ port, database });
  let open: net.Socket | undefined;
  try {
    open = net.connect(port, '127.0.0.1');
    await once(open, 'connect');
    open.write('GET /livez HTTP/1.1\r\nHost: localhost\r\n');
    const pending = get(port, '/readyz').catch(() => undefined);
    await new Promise(resolve => setTimeout(resolve, 100));
    const started = Date.now();
    const firstStop = running.stop();
    assert.equal(running.stop(), firstStop);
    await firstStop;
    assert(Date.now() - started < 5_500);
    await pending;
    const restarted = await startServer({ port, database: null });
    try {
      assert.equal((await get(port, '/livez')).status, 200);
    } finally {
      await restarted.stop();
    }
  } finally {
    open?.destroy();
    await running.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => stalled.close(() => resolve()));
  }
});

test('stop awaits PG cleanup after readiness caller disconnects', async () => {
  const sockets = new Set<net.Socket>();
  let accepted!: (socket: net.Socket) => void;
  const acceptedSocket = new Promise<net.Socket>(resolve => { accepted = resolve; });
  let closed = false;
  const stalled = net.createServer(socket => {
    sockets.add(socket);
    accepted(socket);
    socket.resume();
    socket.on('close', () => {
      closed = true;
      sockets.delete(socket);
    });
  });
  stalled.listen(0, '127.0.0.1');
  await once(stalled, 'listening');
  const address = stalled.address();
  assert(address && typeof address !== 'string');
  const port = await freePort();
  const database = parseDatabaseUrl(`postgres://alice:${credential}@127.0.0.1:${address.port}/tcg_live`);
  assert(database);
  const running = await startServer({ port, database });
  let caller: net.Socket | undefined;
  try {
    caller = net.connect(port, '127.0.0.1');
    await once(caller, 'connect');
    caller.write('GET /readyz HTTP/1.1\r\nHost: localhost\r\n\r\n');
    await acceptedSocket;
    const callerClosed = once(caller, 'close');
    caller.destroy();
    await callerClosed;
    await running.stop();
    if (!closed) {
      let peerTimer: NodeJS.Timeout | undefined;
      await Promise.race([
        once(await acceptedSocket, 'close'),
        new Promise<never>((_, reject) => {
          peerTimer = setTimeout(() => reject(new Error('PG peer socket stayed open after stop')), 500);
        })
      ]).finally(() => { if (peerTimer) clearTimeout(peerTimer); });
    }
    assert.equal(closed, true, 'PG peer socket must close after stop without fixture teardown');
  } finally {
    caller?.destroy();
    await running.stop();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => stalled.close(() => resolve()));
  }
});

async function runUntilListening(env: NodeJS.ProcessEnv, port: number): Promise<{ child: ChildProcessWithoutNullStreams; output: () => string }> {
  const child = spawn(process.execPath, [mainPath], { env: { ...process.env, ...env, PORT: String(port) }, stdio: 'pipe' });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    new Promise<void>(resolve => child.stdout.on('data', chunk => {
      if (String(chunk).includes('listening')) resolve();
    })),
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('child did not start')), 3_000); })
  ]).finally(() => { if (timer) clearTimeout(timer); });
  return { child, output: () => output };
}

test('compiled process never prints synthetic credentials from config or failed probe', async () => {
  for (const url of [
    `postgres://alice:${credential}@remote.example:5432/tcg_live`,
    `postgres://alice:${credential}@localhost:bad/tcg_live`
  ]) {
    const bad = spawnSync(process.execPath, [mainPath], {
      env: { ...process.env, DATABASE_URL: url, PORT: '3000' },
      encoding: 'utf8', timeout: 3_000
    });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Invalid configuration/);
    assert.doesNotMatch(bad.stdout + bad.stderr, new RegExp(credential));
  }
  const dbPort = await freePort();
  const port = await freePort();
  const launched = await runUntilListening({ DATABASE_URL: `postgres://alice:${credential}@127.0.0.1:${dbPort}/tcg_live` }, port);
  try {
    assert.equal((await get(port, '/readyz')).status, 503);
  } finally {
    launched.child.kill();
    await once(launched.child, 'exit');
  }
  assert.doesNotMatch(launched.output(), new RegExp(credential));
});
