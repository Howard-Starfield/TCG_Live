import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { test } from 'node:test';
import { ADMIN } from './domain.js';
import {
  applyRehearsalCommand, createRehearsalEvent, getRehearsalAudit,
  getRehearsalEvent, rehearsalClient, setupRehearsalSchema
} from './store.js';

const optIn = process.env.npm_lifecycle_event === 'test:db';
const skip = optIn ? false : 'Real database suite is opt-in: npm run test:db';

async function freePort(): Promise<number> {
  const server = net.createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}

test('real database: schema marker, command races, audit rollback, and refused writes', { skip }, async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for the opt-in database suite.');
  assert.equal(await setupRehearsalSchema(), 'already_ready');
  const event = await createRehearsalEvent(10_000);
  const id = event.id;
  const runner = 'db-test-runner';
  const run = (commandId: string, actor: string, command: Parameters<typeof applyRehearsalCommand>[3], now = 1_000) =>
    applyRehearsalCommand(id, commandId, actor, command, runner, now);

  const duplicate = await Promise.all([
    run('checkin-A', 'player:A', { type: 'checkin' }),
    run('checkin-A', 'player:A', { type: 'checkin' })
  ]);
  assert.deepEqual(duplicate[0], duplicate[1]);
  assert.equal((await getRehearsalEvent(id)).version, 1);
  assert.equal((await getRehearsalAudit(id)).length, 1);
  await assert.rejects(run('checkin-A', 'player:B', { type: 'checkin' }), /conflicts/);
  assert.equal((await getRehearsalEvent(id)).version, 1);
  for (const player of ['B', 'C', 'D'] as const) await run(`checkin-${player}`, `player:${player}`, { type: 'checkin' });
  assert.equal((await run('checkin-A-new', 'player:A', { type: 'checkin' })).applied, false);
  const published = await run('checkin-A-new', ADMIN, { type: 'publish' });
  assert.equal(published.applied, true);
  await assert.rejects(run('checkin-A-new', 'player:A', { type: 'checkin' }), /conflicts/);
  await run('ready-A', 'player:A', { type: 'ready', matchId: 'M1' });
  await run('ready-B', 'player:B', { type: 'ready', matchId: 'M1' });
  const beforeRejected = await getRehearsalEvent(id);
  await assert.rejects(run('outsider-pause', 'player:C', { type: 'pause', matchId: 'M1' }, 2_000), /denied/);
  await assert.rejects(
    applyRehearsalCommand(id, 'other-runner-clock', ADMIN, { type: 'clockCheck', matchId: 'M1' }, 'different-runner', 11_000),
    /unsupported/
  );
  const storeUrl = new URL('./store.js', import.meta.url).href;
  const foreignCode = `import(${JSON.stringify(storeUrl)}).then(async m => { try { await m.applyRehearsalCommand(${JSON.stringify(id)}, 'foreign-child-clock', 'admin:fixture', {type:'clockCheck',matchId:'M1'}, 'foreign-child-runner', 11000); process.exitCode=2; } catch(e) { if(e.message.includes('unsupported')) process.stdout.write('foreign-runner-rejected\\n'); else process.exitCode=3; } }).catch(() => { process.exitCode=4; });`;
  const foreign = spawnSync(process.execPath, ['--input-type=module', '-e', foreignCode], {
    env: process.env, encoding: 'utf8', timeout: 10_000
  });
  assert.equal(foreign.status, 0, 'fresh child must reject the running-clock mutation');
  assert.match(foreign.stdout, /foreign-runner-rejected/);
  assert.deepEqual(await getRehearsalEvent(id), beforeRejected);

  const proposals = await Promise.allSettled([
    run('proposal-A', 'player:A', { type: 'propose', matchId: 'M1', winner: 'A', expectedRevision: 0 }),
    run('proposal-B', 'player:B', { type: 'propose', matchId: 'M1', winner: 'B', expectedRevision: 0 })
  ]);
  assert.equal(proposals.filter(item => item.status === 'fulfilled').length, 1);
  assert.equal(proposals.filter(item => item.status === 'rejected').length, 1);
  const afterRace = await getRehearsalEvent(id);
  assert.equal(afterRace.matches[0].proposal?.revision, 1);
  assert.equal((await getRehearsalAudit(id)).length, afterRace.version);

  const setupClient = rehearsalClient();
  setupClient.on('error', () => {});
  await setupClient.connect();
  try {
    await setupClient.query("CREATE FUNCTION public.tcg_rehearsal_fail_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic audit failure'; END; $$");
    await setupClient.query('CREATE TRIGGER tcg_rehearsal_fail_audit BEFORE INSERT ON public.tcg_rehearsal_audit FOR EACH ROW EXECUTE FUNCTION public.tcg_rehearsal_fail_audit()');
    await assert.rejects(run('rollback-check', ADMIN, { type: 'clockCheck', matchId: 'M1' }, 2_000),
      /Rehearsal database operation failed/);
  } finally {
    try {
      await setupClient.query('DROP TRIGGER IF EXISTS tcg_rehearsal_fail_audit ON public.tcg_rehearsal_audit');
    } finally {
      try {
        await setupClient.query('DROP FUNCTION IF EXISTS public.tcg_rehearsal_fail_audit()');
      } finally {
        await setupClient.end();
      }
    }
  }
  assert.deepEqual(await getRehearsalEvent(id), afterRace);
  assert.equal((await getRehearsalAudit(id)).length, afterRace.version);

  const originalUrl = process.env.DATABASE_URL;
  assert(originalUrl);
  try {
    const refused = new URL(originalUrl);
    refused.port = String(await freePort());
    process.env.DATABASE_URL = refused.toString();
    await assert.rejects(createRehearsalEvent(), /Rehearsal database operation failed/);
    refused.port = new URL(originalUrl).port;
    refused.pathname = '/not_the_fixture';
    process.env.DATABASE_URL = refused.toString();
    await assert.rejects(createRehearsalEvent(), /exact tcg_rehearsal database/);
  } finally {
    process.env.DATABASE_URL = originalUrl;
  }
});
