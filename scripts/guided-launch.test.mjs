import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { claimOrReuse, ownedRecord, parseLauncherArgs, probeOwned, runOwnedLaunch, supportedNode } from './guided-launch.mjs';

const withFiles = async run => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tcg-launch-test-'));
  const file = path.join(root, 'data', 'guided-instance.json');
  try { return await run({ root, file, port: 34567 }); }
  finally { await rm(root, { recursive: true, force: true }); }
};

test('Node support boundary is 24.15 through 24.x', () => {
  assert.equal(supportedNode('24.14.9'), false);
  assert.equal(supportedNode('24.15.0'), true);
  assert.equal(supportedNode('24.22.1'), true);
  assert.equal(supportedNode('25.0.0'), false);
});

test('headless option is explicit and reuse honors the supplied browser opener', async () => withFiles(async options => {
  assert.deepEqual(parseLauncherArgs(['--no-browser']), { noBrowser: true });
  assert.throws(() => parseLauncherArgs(['--unexpected']), /Unknown guided launch option/);
  const first = await claimOrReuse({ ...options, occupied: async () => false });
  await claimOrReuse({ ...options, probe: async () => ({ present: false,
    loginUrl: `http://127.0.0.1:${options.port}/#login=${'a'.repeat(43)}` }),
  openBrowser: () => {}, alive: () => true });
  await first.release();
}));

test('second launch reuses verified owner; open tab stays single and closed tab gets one link', async () => withFiles(async options => {
  const first = await claimOrReuse({ ...options, occupied: async () => false });
  assert.equal(first.reused, false);
  assert(ownedRecord(JSON.parse(await readFile(options.file, 'utf8')), options.root, options.port));
  const opened = [];
  const second = await claimOrReuse({ ...options, probe: async () => ({ present: true }),
    openBrowser: url => opened.push(url), alive: () => true });
  assert.deepEqual(second, { reused: true, present: true });
  assert.deepEqual(opened, []);
  const url = `http://127.0.0.1:${options.port}/#login=${'a'.repeat(43)}`;
  const third = await claimOrReuse({ ...options, probe: async () => ({ present: false, loginUrl: url }),
    openBrowser: link => opened.push(link), alive: () => true });
  assert.deepEqual(third, { reused: true, present: false });
  assert.deepEqual(opened, [url]);
  await first.release();
}));

test('a double-click during the first build waits for its owner instead of building again', async () => withFiles(async options => {
  const first = await claimOrReuse({ ...options, occupied: async () => false });
  let probes = 0;
  let ticks = 0;
  const second = await claimOrReuse({ ...options, probe: async () => {
    probes++;
    return probes < 3 ? null : { present: true };
  }, alive: () => true, sleep: async () => {}, now: () => ++ticks, maxWaitMs: 100 });
  assert.deepEqual(second, { reused: true, present: true });
  assert.equal(probes, 3);
  await first.release();
}));

test('stale dead owner is reclaimed without killing its PID; live unknown owner and port block build', async () => withFiles(async options => {
  const first = await claimOrReuse({ ...options, occupied: async () => false });
  const stale = first.record;
  let kills = 0;
  const next = await claimOrReuse({ ...options, probe: async () => null, alive: () => { kills++; return false; },
    occupied: async () => false });
  assert.equal(next.reused, false);
  assert.notEqual(next.record.instanceId, stale.instanceId);
  assert(kills > 0);
  await next.release();
  await assert.rejects(() => claimOrReuse({ ...options, occupied: async () => true }), /unverified process/);
  await assert.rejects(() => readFile(options.file, 'utf8'), { code: 'ENOENT' });
}));

test('concurrent stale claims never remove the newly acquired owner', async () => withFiles(async options => {
  const old = await claimOrReuse({ ...options, occupied: async () => false });
  const stale = { ...old.record, pid: 987654321 };
  await writeFile(options.file, JSON.stringify(stale));
  const choice = () => claimOrReuse({ ...options,
    probe: async record => record.instanceId === stale.instanceId ? null : { present: true },
    alive: pid => pid === process.pid, occupied: async () => false, sleep: async () => {},
    maxWaitMs: 5_000 });
  const [a, b] = await Promise.all([choice(), choice()]);
  assert.equal([a, b].filter(item => !item.reused).length, 1);
  assert.equal([a, b].filter(item => item.reused).length, 1);
  const winner = a.reused ? b : a;
  assert.equal(JSON.parse(await readFile(options.file, 'utf8')).instanceId, winner.record.instanceId);
  await winner.release();
}));

test('failed build releases the acquired instance without starting a runtime', async () => withFiles(async options => {
  const claim = await claimOrReuse({ ...options, occupied: async () => false });
  let starts = 0;
  await assert.rejects(() => runOwnedLaunch(claim, {
    build: async () => { throw new Error('build failed'); },
    start: async () => { starts++; return { stop: async () => {} }; },
    stopped: Promise.resolve(), isStopping: () => false
  }), /build failed/);
  assert.equal(starts, 0);
  await assert.rejects(() => readFile(options.file, 'utf8'), { code: 'ENOENT' });
}));

test('foreign record is not removed or treated as the running application', async () => withFiles(async options => {
  await mkdir(path.dirname(options.file), { recursive: true });
  await writeFile(options.file, JSON.stringify({ version: 1, projectRoot: 'different checkout',
    pid: process.pid, port: options.port, instanceId: 'i'.repeat(32), secret: 's'.repeat(43) }));
  await assert.rejects(() => claimOrReuse({ ...options, probe: async () => ({ present: true }) }),
    /different or invalid/);
  assert.equal(JSON.parse(await readFile(options.file, 'utf8')).projectRoot, 'different checkout');
}));

test('launcher accepts only a matching keyed proof and private loopback login URL', async () => {
  const original = globalThis.fetch;
  const record = { port: 34567, instanceId: 'i'.repeat(32), secret: 's'.repeat(43) };
  try {
    globalThis.fetch = async (_url, init) => {
      const { challenge } = JSON.parse(init.body);
      assert.equal(init.headers['X-TCG-Instance-Key'], record.secret);
      assert.equal(init.redirect, 'manual');
      const proof = createHmac('sha256', record.secret)
        .update(`${record.instanceId}:${challenge}`).digest('base64url');
      return Response.json({ instanceId: record.instanceId, proof, present: false,
        loginUrl: `http://127.0.0.1:${record.port}/#login=${'a'.repeat(43)}` });
    };
    assert.equal((await probeOwned(record)).present, false);
    globalThis.fetch = async () => Response.json({ instanceId: record.instanceId, proof: 'forged',
      present: false, loginUrl: `http://127.0.0.1:${record.port}/#login=${'a'.repeat(43)}` });
    assert.equal(await probeOwned(record), null);
  } finally { globalThis.fetch = original; }
});
