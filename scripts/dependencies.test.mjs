import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ensureDependencies, ensureLocalSettings } from './dependencies.mjs';

test('first-run settings use exclusive creation and preserve existing settings', async () => {
  let flags;
  await ensureLocalSettings('/app', async (_source, _target, value) => { flags = value; });
  assert.ok(flags);
  await ensureLocalSettings('/app', async () => { throw Object.assign(Error('exists'), { code: 'EEXIST' }); });
  await assert.rejects(ensureLocalSettings('/app', async () => { throw Object.assign(Error('private detail'), { code: 'EACCES' }); }), /writable application folder/);
});

test('dependency install runs once, repeats for a changed lock or missing package, and does not mark failures ready', async () => {
  let lock = 'lock-v1', marker, ready = true, installs = 0, failed = false;
  const options = { version: '24.22.2', platform: 'win32', arch: 'x64', log() {}, exists: () => ready,
    async read(file) { if (file.endsWith('package-lock.json')) return lock; if (!marker) throw Error('missing'); return marker; },
    async write(_file, value) { marker = value; }, async move() {}, async makeDirectory() {} };
  const install = async () => { installs++; if (failed) throw Error('private internal failure'); };
  assert.equal(await ensureDependencies('/app', install, options), true);
  assert.equal(await ensureDependencies('/app', install, options), false);
  lock = 'lock-v2';
  await ensureDependencies('/app', install, options);
  ready = false;
  await ensureDependencies('/app', install, options);
  assert.equal(installs, 3);
  const prior = marker;
  failed = true;
  await assert.rejects(ensureDependencies('/app', install, options), error => /internet\/proxy/.test(error.message) && !error.message.includes('private internal'));
  assert.equal(marker, prior);
});
