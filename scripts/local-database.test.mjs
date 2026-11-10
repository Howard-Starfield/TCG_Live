import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureLocalDatabase, runQuietCommand } from './local-database.mjs';

async function fixture(run) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'tcg-local-db-test-'));
  const bin = path.join(root, '.local', 'postgresql', 'pgsql', 'bin');
  const data = path.join(root, 'data', 'postgres');
  await mkdir(bin, { recursive: true });
  try { return await run({ root, bin, data }); }
  finally {
    assert(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await rm(root, { recursive: true, force: true });
  }
}

function credentials(data, port = 51948) {
  return { host: '127.0.0.1', port, database: 'tcg_rehearsal',
    adminUser: 'synthetic_admin', adminPassword: 'synthetic_admin_secret',
    user: 'synthetic_app', password: 'synthetic_app_secret', dataDirectory: data };
}

async function legacy(root, data, record = credentials(data)) {
  const file = path.join(root, '.local', 'postgresql', 'credentials.json');
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(data, { recursive: true });
  await writeFile(path.join(data, 'PG_VERSION'), '18\n');
  await writeFile(file, JSON.stringify(record));
  return record;
}

function fakeClient(data, { wrongDirectory = false, provision = false, listener = '127.0.0.1' } = {}) {
  const queries = [];
  let role = !provision;
  let database = !provision;
  const factory = async config => ({
    on() {}, async connect() {}, async end() {},
    async query(sql) {
      queries.push(sql);
      if (sql === 'SHOW data_directory')
        return { rows: [{ data_directory: wrongDirectory ? path.join(data, 'foreign') : data }] };
      if (sql === 'SHOW server_version') return { rows: [{ server_version: '18.6' }] };
      if (sql === 'SHOW listen_addresses') return { rows: [{ listen_addresses: listener }] };
      if (sql.startsWith('SELECT current_database()'))
        return { rows: [{ database: config.database, username: config.user, superuser: false }] };
      if (sql.startsWith('SELECT rolname')) return { rows: role ? [{ rolname: 'tcg_rehearsal',
        rolsuper: false, rolcanlogin: true }] : [] };
      if (sql.startsWith('SELECT pg_get_userbyid')) return { rows: database ? [{ owner: 'tcg_rehearsal' }] : [] };
      if (sql.startsWith('CREATE ROLE')) { role = true; return { rows: [] }; }
      if (sql.startsWith('CREATE DATABASE')) { database = true; return { rows: [] }; }
      throw new Error('unexpected synthetic SQL');
    }
  });
  return { factory, queries };
}

test('explicit unrelated database URL is untouched without installing or probing PostgreSQL', async () =>
  fixture(async ({ root, data }) => {
    const env = { DATABASE_URL: 'postgresql://external:private@127.0.0.1:5433/other' };
    await mkdir(data, { recursive: true });
    await writeFile(path.join(root, 'data', 'local-database.json'), '{invalid');
    const result = await ensureLocalDatabase({ root, env, dependencies: {
      ensurePostgres: async () => { throw new Error('must not install'); }
    } });
    assert.deepEqual(result, { managed: false });
    assert.equal(env.DATABASE_URL, 'postgresql://external:private@127.0.0.1:5433/other');
  }));

test('known safe runtime setup guidance survives while unknown downloader errors stay redacted', async () =>
  fixture(async ({ root }) => {
    const known = Object.assign(new Error('Install the supported VC runtime.'),
      { code: 'TCG_RUNTIME_SETUP' });
    await assert.rejects(ensureLocalDatabase({ root, env: {}, dependencies: {
      ensurePostgres: async () => { throw known; }
    } }), error => error === known);
    await assert.rejects(ensureLocalDatabase({ root, env: {}, dependencies: {
      ensurePostgres: async () => { throw new Error('synthetic private details'); }
    } }), error => {
      assert.match(error.message, /could not be installed or verified/);
      assert.doesNotMatch(error.message, /synthetic private details/);
      return true;
    });
  }));

test('exact legacy URL reuses only authenticated cluster at this checkout data directory', async () =>
  fixture(async ({ root, bin, data }) => {
    const record = await legacy(root, data);
    const url = 'postgresql://synthetic_app:synthetic_app_secret@127.0.0.1:51948/tcg_rehearsal';
    const env = { DATABASE_URL: url };
    const { factory, queries } = fakeClient(data);
    const commands = [];
    const result = await ensureLocalDatabase({ root, env, dependencies: {
      ensurePostgres: async () => bin, occupied: async () => true, clientFactory: factory,
      runCommand: async (file, args) => { commands.push([file, args]); return 'postgres (PostgreSQL) 18.6'; }
    } });
    assert.equal(result.managed, true);
    assert.equal(result.started, false);
    assert.equal(result.port, 51948);
    assert.equal(env.DATABASE_URL, url);
    assert.equal(commands.length, 1, 'running owned cluster needs only a binary version check');
    assert(queries.includes('SHOW data_directory'));
    assert(!queries.some(sql => sql.startsWith('CREATE ')), 'legacy cluster is never provisioned');
    assert.equal(record.dataDirectory, data);
  }));

test('occupied wrong server is refused before any provisioning', async () =>
  fixture(async ({ root, bin, data }) => {
    await legacy(root, data);
    const { factory, queries } = fakeClient(data, { wrongDirectory: true });
    const env = {};
    await assert.rejects(ensureLocalDatabase({ root, env, dependencies: {
      ensurePostgres: async () => bin, occupied: async () => true, clientFactory: factory,
      runCommand: async () => 'postgres (PostgreSQL) 18.6'
    } }), /occupied by an unverified server/);
    assert(!queries.some(sql => sql.startsWith('CREATE ')));
    assert.equal(env.DATABASE_URL, undefined);
  }));

test('nonempty unknown data directory is never reinitialized', async () =>
  fixture(async ({ root, bin, data }) => {
    await mkdir(data, { recursive: true });
    await writeFile(path.join(data, 'PG_VERSION'), '18\n');
    const commands = [];
    await assert.rejects(ensureLocalDatabase({ root, env: {}, dependencies: {
      ensurePostgres: async () => bin, runCommand: async (...args) => { commands.push(args); }
    } }), /no matching managed credentials/);
    assert.deepEqual(commands, []);
    assert.equal(await readFile(path.join(data, 'PG_VERSION'), 'utf8'), '18\n');
  }));

test('fresh empty checkout initializes one loopback cluster and provisions only fixed role and database', async () =>
  fixture(async ({ root, bin, data }) => {
    const env = {};
    const { factory, queries } = fakeClient(data, { provision: true });
    const commands = [];
    const result = await ensureLocalDatabase({ root, env, dependencies: {
      ensurePostgres: async () => bin, occupied: async () => false, freePort: async () => 51949,
      clientFactory: factory,
      runCommand: async (file, args) => {
        commands.push([path.basename(file), args]);
        if (file.endsWith('initdb.exe')) {
          await mkdir(data, { recursive: true });
          await writeFile(path.join(data, 'PG_VERSION'), '18\n');
        }
        return file.endsWith('postgres.exe') ? 'postgres (PostgreSQL) 18.6' : '';
      }
    } });
    assert.equal(result.managed, true);
    assert.equal(result.started, true);
    const saved = JSON.parse(await readFile(path.join(root, 'data', 'local-database.json'), 'utf8'));
    assert.equal(saved.marker, 'tcg-live-local-postgres');
    assert.equal(saved.dataDirectory, path.join('data', 'postgres'));
    assert.equal(saved.binDirectory, path.join('.local', 'postgresql', 'pgsql', 'bin'));
    assert.equal(saved.port, 51949);
    assert(env.DATABASE_URL.includes('@127.0.0.1:51949/tcg_rehearsal'));
    assert.deepEqual(commands.map(([name]) => name), ['initdb.exe', 'postgres.exe', 'pg_ctl.exe']);
    assert(commands[0][1].includes('--auth-host=scram-sha-256'));
    assert(commands[2][1].includes('-w'));
    assert.equal(commands[2][1][commands[2][1].indexOf('-l') + 1],
      path.join(root, '.local', 'postgresql', 'server.log'),
      'the pg_ctl log must stay outside PGDATA so crash-recovery fsync cannot reopen it');
    assert(queries.some(sql => sql.startsWith('CREATE ROLE tcg_rehearsal ')));
    assert(queries.includes('CREATE DATABASE tcg_rehearsal OWNER tcg_rehearsal'));
    const explicitlySelected = { DATABASE_URL: env.DATABASE_URL };
    const second = await ensureLocalDatabase({ root, env: explicitlySelected, dependencies: {
      ensurePostgres: async () => bin, occupied: async () => true, clientFactory: factory,
      runCommand: async () => 'postgres (PostgreSQL) 18.6'
    } });
    assert.equal(second.managed, true, 'exact saved managed URL is owned');
    assert.equal(second.started, false);
    assert.equal(explicitlySelected.DATABASE_URL, env.DATABASE_URL);
  }));

test('persisted fresh credentials survive initdb failure and retry only while PGDATA is empty', async () =>
  fixture(async ({ root, bin, data }) => {
    const env = {};
    await assert.rejects(ensureLocalDatabase({ root, env, dependencies: {
      ensurePostgres: async () => bin, freePort: async () => 51949,
      runCommand: async file => {
        if (file.endsWith('initdb.exe')) throw new Error('synthetic interruption');
        return 'postgres (PostgreSQL) 18.6';
      }
    } }), /initialization failed/);
    const saved = JSON.parse(await readFile(path.join(root, 'data', 'local-database.json'), 'utf8'));
    assert(saved.password && saved.adminPassword, 'credentials were saved before initdb');
    const { factory } = fakeClient(data, { provision: true });
    const replay = await ensureLocalDatabase({ root, env, dependencies: {
      ensurePostgres: async () => bin, occupied: async () => false, clientFactory: factory,
      runCommand: async file => {
        if (file.endsWith('initdb.exe')) {
          await mkdir(data, { recursive: true });
          await writeFile(path.join(data, 'PG_VERSION'), '18\n');
        }
        return file.endsWith('postgres.exe') ? 'postgres (PostgreSQL) 18.6' : '';
      }
    } });
    assert.equal(replay.managed, true);
    assert.equal(JSON.parse(await readFile(path.join(root, 'data', 'local-database.json'), 'utf8')).password,
      saved.password, 'replay keeps the same generated password');
    assert(env.DATABASE_URL.includes('@127.0.0.1:51949/tcg_rehearsal'));
  }));

test('partial managed PGDATA is preserved and never sent to initdb again', async () =>
  fixture(async ({ root, bin, data }) => {
    await assert.rejects(ensureLocalDatabase({ root, env: {}, dependencies: {
      ensurePostgres: async () => bin, freePort: async () => 51949,
      runCommand: async file => {
        if (file.endsWith('initdb.exe')) {
          await mkdir(data, { recursive: true });
          await writeFile(path.join(data, 'partial'), 'keep');
          throw new Error('synthetic init failure');
        }
        return 'postgres (PostgreSQL) 18.6';
      }
    } }), /initialization failed/);
    let commands = 0;
    await assert.rejects(ensureLocalDatabase({ root, env: {}, dependencies: {
      ensurePostgres: async () => bin,
      runCommand: async () => { commands++; return 'postgres (PostgreSQL) 18.6'; }
    } }), /Partial PostgreSQL data was preserved/);
    assert.equal(commands, 0);
    assert.equal(await readFile(path.join(data, 'partial'), 'utf8'), 'keep');
  }));

test('authenticated server advertising a non-loopback listener is refused', async () =>
  fixture(async ({ root, bin, data }) => {
    await legacy(root, data);
    const { factory } = fakeClient(data, { listener: '*' });
    await assert.rejects(ensureLocalDatabase({ root, env: {}, dependencies: {
      ensurePostgres: async () => bin, occupied: async () => true,
      clientFactory: factory, runCommand: async () => 'postgres (PostgreSQL) 18.6'
    } }), /unverified server/);
  }));

test('stopped owned legacy cluster is restarted by pg_ctl without changing its lock file', async () =>
  fixture(async ({ root, bin, data }) => {
    await legacy(root, data);
    const lock = path.join(data, 'postmaster.pid');
    await writeFile(lock, 'synthetic stopped-cluster marker');
    const { factory } = fakeClient(data);
    const commands = [];
    const env = {};
    const result = await ensureLocalDatabase({ root, env, dependencies: {
      ensurePostgres: async () => bin, occupied: async () => false, clientFactory: factory,
      runCommand: async (file, args) => {
        commands.push([path.basename(file), args]);
        return file.endsWith('postgres.exe') ? 'postgres (PostgreSQL) 18.6' : '';
      }
    } });
    assert.equal(result.started, true);
    assert.deepEqual(commands.map(([name]) => name), ['postgres.exe', 'pg_ctl.exe']);
    assert.equal(commands[1][1][commands[1][1].indexOf('-l') + 1],
      path.join(root, '.local', 'postgresql', 'server.log'));
    assert.equal(await readFile(lock, 'utf8'), 'synthetic stopped-cluster marker');
    assert(env.DATABASE_URL.includes('@127.0.0.1:51948/tcg_rehearsal'));
  }));

test('failed pg_ctl start returns fixed error without leaking private process details', async () =>
  fixture(async ({ root, bin, data }) => {
    await legacy(root, data);
    const env = {};
    await assert.rejects(ensureLocalDatabase({ root, env, dependencies: {
      ensurePostgres: async () => bin, occupied: async () => false,
      runCommand: async file => {
        if (file.endsWith('pg_ctl.exe')) throw new Error('synthetic_admin_secret');
        return 'postgres (PostgreSQL) 18.6';
      }
    } }), error => {
      assert.match(error.message, /could not be started/);
      assert.doesNotMatch(error.message, /synthetic_admin_secret/);
      return true;
    });
    assert.equal(env.DATABASE_URL, undefined);
  }));

test('quiet PostgreSQL helper resolves on exit without waiting for inherited stream closure', async () => {
  const child = new EventEmitter();
  child.kill = () => {};
  const result = runQuietCommand('pg_ctl.exe', ['start'], 100, (_file, _args, options) => {
    assert.equal(options.stdio, 'ignore');
    assert.equal(options.windowsHide, true);
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
  assert.equal(await result, '');
});
