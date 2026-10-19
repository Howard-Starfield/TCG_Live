// Security smoke over raw HTTP (node:http, so Host and unnormalised paths go out exactly as written):
// Host and Origin allowlists, no CORS, health routes, static traversal, headers and the login rate limit.
import { expect, test } from '@playwright/test';
import { sharedBearer, SHARED_ORIGIN, SHARED_TOKEN } from './support/console';
import { startDemo } from './support/demo';
import { rawRequest } from './support/http';

const raw = rawRequest;

const port = new URL(SHARED_ORIGIN).port;
const json = { 'Content-Type': 'application/json' };

test.describe('request checks', () => {
  test('a wrong Host is refused for the API and the app shell (DNS rebinding)', async () => {
    const bearer = await sharedBearer();
    for (const host of [`evil.example:${port}`, `127.0.0.1:${Number(port) + 1}`, '127.0.0.1', `[::1]:${port}`]) {
      const api = await raw(SHARED_ORIGIN, 'GET', '/api/v1/status', { Host: host, Authorization: `Bearer ${bearer}` });
      expect(api.status, host).toBe(403);
      expect(JSON.parse(api.body).error.code).toBe('bad_host');
      const shell = await raw(SHARED_ORIGIN, 'GET', '/', { Host: host });
      expect(shell.status, host).toBe(403);
    }
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`]) {
      expect((await raw(SHARED_ORIGIN, 'GET', '/api/v1/status', { Host: host, Authorization: `Bearer ${bearer}` })).status, host).toBe(200);
    }
  });

  test('non-GET API calls need an allowlisted Origin', async () => {
    const body = JSON.stringify({ token: SHARED_TOKEN });
    const missing = await raw(SHARED_ORIGIN, 'POST', '/api/v1/session', json, body);
    expect(missing.status).toBe(403);
    expect(JSON.parse(missing.body).error.code).toBe('bad_origin');
    for (const origin of ['http://evil.example', `http://127.0.0.1:${Number(port) + 1}`, 'null', `https://127.0.0.1:${port}`]) {
      const wrong = await raw(SHARED_ORIGIN, 'POST', '/api/v1/session', { ...json, Origin: origin }, body);
      expect(wrong.status, origin).toBe(403);
    }
    const bearer = await sharedBearer();
    const logout = await raw(SHARED_ORIGIN, 'DELETE', '/api/v1/session', { Authorization: `Bearer ${bearer}` });
    expect(logout.status).toBe(403);
    // The shared bearer is still valid: the refused DELETE did nothing.
    expect((await raw(SHARED_ORIGIN, 'GET', '/api/v1/session', { Authorization: `Bearer ${bearer}` })).status).toBe(200);
    for (const origin of [SHARED_ORIGIN, `http://localhost:${port}`]) {
      expect((await raw(SHARED_ORIGIN, 'POST', '/api/v1/session', { ...json, Origin: origin }, body)).status, origin).toBe(200);
    }
  });

  test('no CORS headers, even for a foreign Origin', async () => {
    const bearer = await sharedBearer();
    const response = await raw(SHARED_ORIGIN, 'GET', '/api/v1/status', { Authorization: `Bearer ${bearer}`, Origin: 'http://evil.example' });
    expect(response.status).toBe(200);
    expect(Object.keys(response.headers).filter(name => name.startsWith('access-control-'))).toEqual([]);
    const preflight = await raw(SHARED_ORIGIN, 'OPTIONS', '/api/v1/session', { Origin: 'http://evil.example', 'Access-Control-Request-Method': 'POST' });
    expect(preflight.status).toBeGreaterThanOrEqual(400);
    expect(Object.keys(preflight.headers).filter(name => name.startsWith('access-control-'))).toEqual([]);
  });

  test('the API needs a bearer token', async () => {
    for (const path of ['/api/v1/status', '/api/v1/events', '/api/v1/stream', '/api/v1/session']) {
      const response = await raw(SHARED_ORIGIN, 'GET', path);
      expect(response.status, path).toBe(401);
      expect(response.headers['www-authenticate']).toBe('Bearer');
    }
    expect((await raw(SHARED_ORIGIN, 'GET', '/api/v1/status', { Authorization: 'Bearer not-a-real-token' })).status).toBe(401);
  });
});

test.describe('health routes and static files', () => {
  test('/livez still answers; /readyz reports no database in the demo', async () => {
    const live = await raw(SHARED_ORIGIN, 'GET', '/livez');
    expect(live.status).toBe(200);
    expect(JSON.parse(live.body)).toEqual({ status: 'live' });
    // Health is the server's own route: it ignores the admin Host check.
    expect((await raw(SHARED_ORIGIN, 'GET', '/livez', { Host: 'evil.example' })).status).toBe(200);
    expect((await raw(SHARED_ORIGIN, 'GET', '/readyz')).status).toBe(503);
    // Near-misses are a 404, never the app shell.
    for (const path of ['/livez/', '/LIVEZ', '/%6civez', '/readyz?x=1']) {
      const response = await raw(SHARED_ORIGIN, 'GET', path);
      expect(response.status, path).toBe(404);
      expect(response.body, path).not.toContain('<div id="root">');
    }
  });

  test('static traversal attempts get 400', async () => {
    for (const path of ['/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/package.json', '/assets/..%5c..%5cpackage.json',
      '/assets/%2e%2e%2f%2e%2e%2fserver%2fdist%2fadmin%2fdemo.js', '/C:%5cWindows%5cwin.ini', '/.env', '/%00index.html']) {
      const response = await raw(SHARED_ORIGIN, 'GET', path);
      expect(response.status, path).toBe(400);
      expect(response.body, path).not.toContain('"name": "tcg-live"');
    }
  });

  test('security headers on the shell and the API', async () => {
    const shell = await raw(SHARED_ORIGIN, 'GET', '/');
    expect(shell.status).toBe(200);
    expect(shell.headers['content-security-policy']).toBe(
      "default-src 'self'; img-src 'self' data: https://cdn.discordapp.com; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    expect(shell.headers['referrer-policy']).toBe('no-referrer');
    expect(shell.headers['x-content-type-options']).toBe('nosniff');
    expect(shell.headers['cache-control']).toBe('no-cache');
    expect(shell.body).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg"');
    const icon = await raw(SHARED_ORIGIN, 'GET', '/favicon.svg');
    expect(icon.status).toBe(200);
    expect(icon.headers['content-type']).toBe('image/svg+xml');
    const asset = /\/assets\/[^"]+\.js/.exec(shell.body)![0];
    expect((await raw(SHARED_ORIGIN, 'GET', asset)).headers['cache-control']).toBe('public, max-age=31536000, immutable');
    const api = await raw(SHARED_ORIGIN, 'GET', '/api/v1/status', { Authorization: `Bearer ${await sharedBearer()}` });
    expect(api.headers['cache-control']).toBe('no-store');
    expect(api.headers['x-content-type-options']).toBe('nosniff');
  });
});

test('failed sign-ins are rate limited (10 a minute), then even the right token waits', async () => {
  // A private demo: tripping the limit on the shared one would lock the other specs out for a minute.
  const demo = await startDemo();
  try {
    for (let attempt = 1; attempt <= 10; attempt++) {
      const response = await raw(demo.origin, 'POST', '/api/v1/session', { ...json, Origin: demo.origin }, JSON.stringify({ token: `wrong-token-${attempt}-0123456789abcdef` }));
      expect(response.status, `attempt ${attempt}`).toBe(401);
    }
    const limited = await raw(demo.origin, 'POST', '/api/v1/session', { ...json, Origin: demo.origin }, JSON.stringify({ token: demo.token }));
    expect(limited.status).toBe(429);
    expect(limited.headers['retry-after']).toBe('60');
    // Tokens never reach the logs.
    expect(demo.stdout().split(demo.token).length - 1).toBe(1);   // the startup link only
    expect(demo.stderr()).not.toContain(demo.token);
  } finally {
    await demo.kill();
  }
});
