import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { SetupService } from './service.js';
import { call, login, startHarness } from '../admin/http/test-support.js';

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
