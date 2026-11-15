import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import type { SetupService } from './service.js';
import { call, login, startHarness, waitFor } from '../admin/http/test-support.js';

test('setup routes require the existing bearer session and same-origin write boundary', async () => {
  let checks = 0;
  const setup = { async status() { return { prerequisite: null }; }, async guilds() { return []; },
    async channels() { return []; }, async check() { checks++; return { valid: false }; },
    async finish() { throw new Error('not called'); }, async handover() {} } as unknown as SetupService;
  const harness = await startHarness({ setup });
  try {
    const unauthenticated = await call(harness.port, '/api/v1/setup');
    assert.equal(unauthenticated.status, 401);
    const token = await login(harness);
    const session = await call(harness.port, '/api/v1/session', { token });
    assert.equal(session.json().setup, true);
    const badHost = await call(harness.port, '/api/v1/setup', { token, headers: { Host: 'evil.example' } });
    assert.equal(badHost.status, 403);
    const badOrigin = await call(harness.port, '/api/v1/setup/check', { method: 'POST', token,
      body: '{}', origin: false, headers: { Origin: 'http://evil.example' } });
    assert.equal(badOrigin.status, 403);
    assert.equal(checks, 0);
    assert.equal((await call(harness.port, '/api/v1/setup', { token })).status, 200);
    assert.equal((await call(harness.port, '/api/v1/setup/check', { method: 'POST', token, body: '{}' })).status, 200);
    assert.equal(checks, 1);
  } finally { await harness.stop(); }
});

test('setup hands over even when the client disconnects before the finish reply', async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let finishes = 0;
  let handovers = 0;
  const setup = { async status() { return { prerequisite: null }; },
    async finish() { finishes++; await gate; return { openingDashboard: true, eventId: 'e' }; },
    async handover() { handovers++; } } as unknown as SetupService;
  const harness = await startHarness({ setup });
  try {
    const token = await login(harness);
    const body = '{}';
    const request = http.request({ host: '127.0.0.1', port: harness.port, path: '/api/v1/setup/finish', method: 'POST',
      agent: false, headers: { Authorization: `Bearer ${token}`, Origin: `http://127.0.0.1:${harness.port}`,
        'Content-Type': 'application/json', 'Content-Length': String(body.length) } });
    request.on('error', () => {});
    request.end(body);
    await waitFor(() => finishes === 1, 'finish to start');
    request.destroy();
    await new Promise(resolve => setTimeout(resolve, 50));
    release();
    await waitFor(() => handovers === 1, 'handover after a dropped connection');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(handovers, 1, 'handover is triggered once');

    // A normal reply triggers handover exactly once as well.
    const reply = await call(harness.port, '/api/v1/setup/finish', { method: 'POST', token, body: '{}' });
    assert.equal(reply.status, 200);
    await waitFor(() => handovers === 2, 'handover after a delivered reply');
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(handovers, 2);
  } finally { await harness.stop(); }
});
