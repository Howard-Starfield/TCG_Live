import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { DEFAULT_WEB_DIST, readAdminConfig } from './config.js';

test('Discord mode keeps the console and commands off by default', () => {
  const config = readAdminConfig('discord', {});
  assert.deepEqual(config, { console: false, commandsEnabled: false, devOrigin: null, fixedLoginToken: null, webDist: DEFAULT_WEB_DIST });
  assert.equal(readAdminConfig('discord', { TCG_ADMIN_CONSOLE: '1' }).console, true);
  assert.equal(readAdminConfig('discord', { TCG_ADMIN_CONSOLE: '0', TCG_ADMIN_COMMANDS: '1' }).commandsEnabled, true);
  assert.throws(() => readAdminConfig('discord', { TCG_ADMIN_CONSOLE: 'yes' }), /TCG_ADMIN_CONSOLE must be 0 or 1/);
});

test('demo-only settings are refused in Discord mode and validated in demo mode', () => {
  const token = 'e2e-fixed-launch-token-0123456789abcdef';
  assert.throws(() => readAdminConfig('discord', { TCG_ADMIN_LOGIN_TOKEN: token }), /demo-only/);
  assert.throws(() => readAdminConfig('discord', { TCG_ADMIN_DEV_ORIGIN: 'http://localhost:5173' }), /demo-only/);
  const demo = readAdminConfig('demo', { TCG_ADMIN_LOGIN_TOKEN: token, TCG_ADMIN_DEV_ORIGIN: 'http://localhost:5173/' });
  assert.equal(demo.console, true);
  assert.equal(demo.commandsEnabled, true);
  assert.equal(demo.fixedLoginToken, token);
  assert.equal(demo.devOrigin, 'http://localhost:5173');
  assert.throws(() => readAdminConfig('demo', { TCG_ADMIN_LOGIN_TOKEN: 'short' }), /32 to 128/);
  for (const origin of ['https://localhost:5173', 'http://example.com:5173', 'http://localhost', 'http://localhost:5173/app'])
    assert.throws(() => readAdminConfig('demo', { TCG_ADMIN_DEV_ORIGIN: origin }), /TCG_ADMIN_DEV_ORIGIN/, origin);
});

test('web dist defaults to apps/web/dist regardless of the working directory', () => {
  assert.equal(path.basename(DEFAULT_WEB_DIST), 'dist');
  assert.equal(path.basename(path.dirname(DEFAULT_WEB_DIST)), 'web');
  assert.equal(readAdminConfig('demo', { TCG_ADMIN_WEB_DIST: 'some/dir' }).webDist, path.resolve('some/dir'));
});
