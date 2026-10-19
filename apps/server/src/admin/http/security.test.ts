import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { CONTENT_SECURITY_POLICY } from './respond.js';
import { ASSET_CACHE_CONTROL } from './static.js';
import { call, login, startHarness, type Reply } from './test-support.js';

const SECRET = 'SECRET-OUTSIDE-WEB-DIST';
let sandbox = '';
let webDist = '';

before(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'tcg-admin-http-'));
  webDist = path.join(sandbox, 'dist');
  fs.mkdirSync(path.join(webDist, 'assets'), { recursive: true });
  fs.writeFileSync(path.join(webDist, 'index.html'), '<!doctype html><title>console</title>');
  fs.writeFileSync(path.join(webDist, 'assets', 'app-abc123.js'), 'console.log(1);');
  fs.writeFileSync(path.join(webDist, 'favicon.svg'), '<svg/>');
  fs.writeFileSync(path.join(webDist, '.env'), SECRET);
  fs.writeFileSync(path.join(sandbox, 'secret.txt'), SECRET);
});

after(() => fs.rmSync(sandbox, { recursive: true, force: true }));

function assertSecurityHeaders(reply: Reply, label: string): void {
  assert.equal(reply.headers['content-security-policy'], CONTENT_SECURITY_POLICY, label);
  assert.equal(reply.headers['referrer-policy'], 'no-referrer', label);
  assert.equal(reply.headers['x-content-type-options'], 'nosniff', label);
  for (const name of Object.keys(reply.headers)) assert(!name.startsWith('access-control-'), `${label}: no CORS headers`);
}

test('the CSP is exactly the planned policy', () => {
  assert.equal(CONTENT_SECURITY_POLICY, "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com; " +
    "style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
});

test('Host must name the bound port on 127.0.0.1 or localhost', async () => {
  const harness = await startHarness({ webDist });
  try {
    for (const host of ['evil.example', `evil.example:${harness.port}`, `127.0.0.1:${harness.port + 1}`, '127.0.0.1', `[::1]:${harness.port}`]) {
      const api = await call(harness.port, '/api/v1/status', { headers: { Host: host } });
      assert.equal(api.status, 403, host);
      assert.equal(api.json().error.code, 'bad_host');
      assertSecurityHeaders(api, host);
      const page = await call(harness.port, '/', { headers: { Host: host } });
      assert.equal(page.status, 403, `static ${host}`);
    }
    assert.equal((await call(harness.port, '/api/v1/session', { headers: { Host: `localhost:${harness.port}` } })).status, 401);
    assert.equal((await call(harness.port, '/api/v1/session', { headers: { Host: `LOCALHOST:${harness.port}` } })).status, 401);
    assert.equal((await call(harness.port, '/api/v1/session')).status, 401);
  } finally {
    await harness.stop();
  }
});

test('every non-GET request needs an allowlisted Origin, and no CORS headers are sent', async () => {
  const harness = await startHarness();
  const body = JSON.stringify({ token: harness.launchToken() });
  try {
    for (const origin of [undefined, 'null', 'http://evil.example', `http://127.0.0.1:${harness.port + 1}`, `https://127.0.0.1:${harness.port}`]) {
      const reply = await call(harness.port, '/api/v1/session', {
        method: 'POST', body, origin: false, headers: origin === undefined ? {} : { Origin: origin }
      });
      assert.equal(reply.status, 403, String(origin));
      assert.equal(reply.json().error.code, 'bad_origin');
      assertSecurityHeaders(reply, String(origin));
    }
    const preflight = await call(harness.port, '/api/v1/session', {
      method: 'OPTIONS', origin: false, headers: { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' }
    });
    assert.equal(preflight.status, 403);
    assertSecurityHeaders(preflight, 'preflight');
    for (const origin of [`http://127.0.0.1:${harness.port}`, `http://localhost:${harness.port}`]) {
      const reply = await call(harness.port, '/api/v1/session', { method: 'POST', body, origin: false, headers: { Origin: origin } });
      assert.equal(reply.status, 200, origin);
      assertSecurityHeaders(reply, origin);
    }
  } finally {
    await harness.stop();
  }
});

test('the dev origin is accepted in demo mode only', async () => {
  const devOrigin = 'http://localhost:5173';
  for (const mode of ['demo', 'discord'] as const) {
    const harness = await startHarness({ mode, devOrigin });
    try {
      const reply = await call(harness.port, '/api/v1/session', {
        method: 'POST', origin: false, headers: { Origin: devOrigin }, body: JSON.stringify({ token: harness.launchToken() })
      });
      assert.equal(reply.status, mode === 'demo' ? 200 : 403, mode);
      if (mode === 'discord') assert.equal(reply.json().error.code, 'bad_origin');
    } finally {
      await harness.stop();
    }
  }
});

test('401, 403, 404 and 405 are JSON errors with security headers, and health routes are unchanged', async () => {
  const harness = await startHarness();
  const readOnly = await startHarness({}, { capabilities: [] });
  try {
    const token = await login(harness);
    const missing = await call(harness.port, '/api/v1/nope', { token });
    assert.equal(missing.status, 404);
    assert.deepEqual(missing.json(), { error: { code: 'not_found', message: 'Not found.' } });
    assert.equal(missing.headers['cache-control'], 'no-store');
    assertSecurityHeaders(missing, '404');
    assert.equal((await call(harness.port, '/api/other')).status, 404);
    assert.equal((await call(harness.port, '/api')).status, 404);
    assert.equal((await call(harness.port, '/api/v2/status', { token })).status, 404);

    const wrongMethod = await call(harness.port, '/api/v1/status', { method: 'DELETE', token });
    assert.equal(wrongMethod.status, 405);
    assert.equal(wrongMethod.headers.allow, 'GET');
    assert.equal(wrongMethod.json().error.code, 'method_not_allowed');
    const sessionMethods = await call(harness.port, '/api/v1/session', { method: 'PUT', token, body: '{}' });
    assert.equal(sessionMethods.status, 405);
    assert.equal(sessionMethods.headers.allow, 'GET, POST, DELETE');

    const anonymous = await call(harness.port, '/api/v1/status');
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.json().error.code, 'unauthenticated');
    assert.equal(anonymous.headers['www-authenticate'], 'Bearer');
    assertSecurityHeaders(anonymous, '401');

    const limited = await login(readOnly);
    const forbidden = await call(readOnly.port, '/api/v1/status', { token: limited });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.json().error.code, 'forbidden');
    assertSecurityHeaders(forbidden, '403');
    assert.equal((await call(readOnly.port, '/api/v1/stream', { token: limited })).status, 403);
    const own = await call(readOnly.port, '/api/v1/session', { token: limited });
    assert.equal(own.status, 200);
    assert.deepEqual(own.json().capabilities, []);

    const live = await call(harness.port, '/livez');
    assert.equal(live.status, 200);
    assert.deepEqual(live.json(), { status: 'live' });
    assert.deepEqual((await call(harness.port, '/readyz')).json(), { status: 'not_configured' });
    assert.equal((await call(harness.port, '/livez', { method: 'POST' })).status, 405);
    for (const variant of ['/livez/', '/readyz?x=1', '/livez?x=1', '/readyz/extra']) {
      const reply = await call(harness.port, variant);
      assert.equal(reply.status, 404, variant);
      assert.deepEqual(reply.json(), { status: 'not_found' }, variant);
    }
  } finally {
    await harness.stop();
    await readOnly.stop();
  }
});

test('request bodies must be strict, bounded JSON', async () => {
  const harness = await startHarness();
  const token = harness.launchToken();
  const post = (body: string, headers: Record<string, string> = {}) =>
    call(harness.port, '/api/v1/session', { method: 'POST', body, headers });
  try {
    const cases: [string, Promise<Reply>][] = [
      ['missing content type', call(harness.port, '/api/v1/session', { method: 'POST', body: JSON.stringify({ token }), headers: { 'Content-Type': '' } })],
      ['text/plain', post(JSON.stringify({ token }), { 'Content-Type': 'text/plain' })],
      ['latin1 charset', post(JSON.stringify({ token }), { 'Content-Type': 'application/json; charset=latin1' })],
      ['empty body', post('')],
      ['unknown key', post(JSON.stringify({ token, extra: true }))],
      ['array', post(JSON.stringify([token]))],
      ['non-string token', post(JSON.stringify({ token: 42 }))],
      ['invalid JSON', post('{"token":')],
      ['too deep', post(`{"token":${'['.repeat(20)}${']'.repeat(20)}}`)],
      ['too large', post(JSON.stringify({ token: 'x'.repeat(17 * 1024) }))]
    ];
    for (const [label, pending] of cases) {
      const reply = await pending;
      assert.equal(reply.status, 400, label);
      assert.equal(reply.json().error.code, 'bad_request', label);
      assert.doesNotMatch(reply.text, new RegExp(token), label);
    }
    assert.equal((await post(JSON.stringify({ token }), { 'Content-Type': 'application/json; charset=UTF-8' })).status, 200);

    const bearer = await login(harness);
    const logoutWithBody = await call(harness.port, '/api/v1/session', { method: 'DELETE', token: bearer, body: '{"all":true}' });
    assert.equal(logoutWithBody.status, 400);
    assert.equal((await call(harness.port, '/api/v1/session', { method: 'DELETE', token: bearer, body: '{}' })).status, 204);
  } finally {
    await harness.stop();
  }
});

test('static files: MIME types, cache rules, SPA fallback, HEAD, and non-GET fall through', async () => {
  const harness = await startHarness({ webDist });
  try {
    const index = await call(harness.port, '/');
    assert.equal(index.status, 200);
    assert.equal(index.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(index.headers['cache-control'], 'no-cache');
    assert.match(index.text, /console/);
    assertSecurityHeaders(index, 'index');
    assert.equal((await call(harness.port, '/index.html')).headers['cache-control'], 'no-cache');

    const asset = await call(harness.port, '/assets/app-abc123.js');
    assert.equal(asset.status, 200);
    assert.equal(asset.headers['content-type'], 'text/javascript; charset=utf-8');
    assert.equal(asset.headers['cache-control'], ASSET_CACHE_CONTROL);
    assert.equal(asset.text, 'console.log(1);');
    assertSecurityHeaders(asset, 'asset');
    assert.equal((await call(harness.port, '/favicon.svg')).headers['content-type'], 'image/svg+xml');

    for (const route of ['/events/abc', '/settings/', '/a/b/c?x=1', '/lives-page']) {
      const fallback = await call(harness.port, route);
      assert.equal(fallback.status, 200, route);
      assert.equal(fallback.headers['cache-control'], 'no-cache', route);
      assert.match(fallback.text, /console/, route);
    }
    for (const route of ['/missing.js', '/assets/missing-123.css', '/events/abc.json']) {
      const missing = await call(harness.port, route);
      assert.equal(missing.status, 404, route);
      assert.equal(missing.json().error.code, 'not_found', route);
    }

    const head = await call(harness.port, '/', { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(head.text, '');
    assert.equal(head.headers['content-length'], String(fs.statSync(path.join(webDist, 'index.html')).size));

    const post = await call(harness.port, '/', { method: 'POST', body: '{}' });
    assert.equal(post.status, 404);
    assert.deepEqual(post.json(), { status: 'not_found' });

    for (const variant of ['/livez/', '/readyz?x=1', '/livez/index.html', '/readyz/']) {
      const reply = await call(harness.port, variant);
      assert.equal(reply.status, 404, variant);
      assert.deepEqual(reply.json(), { status: 'not_found' }, variant);
    }
    assert.deepEqual((await call(harness.port, '/livez')).json(), { status: 'live' });
  } finally {
    await harness.stop();
  }
});

test('path traversal and malformed static paths never escape the web build', async () => {
  const harness = await startHarness({ webDist });
  try {
    const attempts = [
      '/../secret.txt', '/%2e%2e/secret.txt', '/%2E%2E%2Fsecret.txt', '/assets/%2e%2e%2f%2e%2e%2fsecret.txt',
      '/..%5csecret.txt', '/assets\\..\\..\\secret.txt', '/%00index.html', '/index.html%00.js', '/.env', '/%2eenv',
      '/C:/Windows/win.ini', `/${encodeURIComponent(path.join(sandbox, 'secret.txt'))}`, '/%E0%A4%A', '//secret.txt',
      '/assets/./app-abc123.js'
    ];
    for (const attempt of attempts) {
      const reply = await call(harness.port, attempt);
      assert(reply.status === 400 || reply.status === 404, `${attempt} -> ${reply.status}`);
      assert.doesNotMatch(reply.text, new RegExp(SECRET), attempt);
      assertSecurityHeaders(reply, attempt);
    }
  } finally {
    await harness.stop();
  }
});

test('without a web build, non-API paths fall through to the server 404', async () => {
  for (const dist of [undefined, path.join(os.tmpdir(), 'tcg-admin-missing-dist-does-not-exist')]) {
    const harness = await startHarness({ webDist: dist });
    try {
      const reply = await call(harness.port, '/');
      assert.equal(reply.status, 404);
      assert.deepEqual(reply.json(), { status: 'not_found' });
      assert.equal((await call(harness.port, '/api/v1/status')).status, 401);
    } finally {
      await harness.stop();
    }
  }
});
