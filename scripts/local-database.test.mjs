import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ensureLocalDatabase, freePort, runQuietCommand } from './local-database.mjs';

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

const syntheticInitdb = data => async (file, _args, _timeout, log) => {
  if (file.endsWith('initdb.exe')) {
    assert.match(log ?? '', /initdb\.log$/);
    await mkdir(path.join(data, 'base', '1'), { recursive: true });
    await writeFile(path.join(data, 'PG_VERSION'), '18\n');
  }
  return file.endsWith('postgres.exe') ? 'postgres (PostgreSQL) 18.6' : '';
};

test('interrupted initdb is moved aside (never deleted) and initialized again', async () =>
  fixture(async ({ root, bin, data }) => {
    await assert.rejects(ensureLocalDatabase({ root, env: {}, dependencies: {
      ensurePostgres: async () => bin, freePort: async () => 21949,
      runCommand: async file => {
        if (file.endsWith('initdb.exe')) {
          await mkdir(path.join(data, 'base', '1'), { recursive: true });
          await writeFile(path.join(data, 'PG_VERSION'), '18\n');
          await writeFile(path.join(data, 'partial'), 'keep');
          throw new Error('synthetic init failure');
        }
        return 'postgres (PostgreSQL) 18.6';
      }
    } }), /initialization failed/);
    const commands = [];
    const run = syntheticInitdb(data);
    const result = await ensureLocalDatabase({ root, env: {}, dependencies: {
      ensurePostgres: async () => bin, occupied: async () => false, clientFactory: fakeClient(data, { provision: true }).factory,
      runCommand: async (...args) => { commands.push(path.basename(args[0])); return run(...args); }
    } });
    assert.equal(result.managed, true);
    assert.equal(commands[0], 'initdb.exe');
    const aside = (await readdir(path.join(root, 'data'))).filter(name => name.startsWith('postgres.incomplete-'));
    assert.equal(aside.length, 1);
    assert.equal(await readFile(path.join(root, 'data', aside[0], 'partial'), 'utf8'), 'keep');
    assert(existsSync(path.join(data, 'tcg-live-initdb.complete')), 'completion marker written after initdb');
  }));

test('managed cluster without the marker is kept when it was ever started or holds user data', async () =>
  fixture(async ({ root, bin, data }) => {
    const record = { ...credentials(data, 21950), version: 1, marker: 'tcg-live-local-postgres',
      dataDirectory: path.join('data', 'postgres'), binDirectory: path.join('.local', 'postgresql', 'pgsql', 'bin') };
    await mkdir(path.join(root, 'data'), { recursive: true });
    await writeFile(path.join(root, 'data', 'local-database.json'), JSON.stringify(record));
    for (const evidence of ['postmaster.opts', path.join('base', '16384')]) {
      await rm(data, { recursive: true, force: true });
      await mkdir(path.join(data, 'base', '1'), { recursive: true });
      await writeFile(path.join(data, 'PG_VERSION'), '18\n');
      if (evidence === 'postmaster.opts') await writeFile(path.join(data, evidence), 'synthetic');
      else await mkdir(path.join(data, evidence));
      const commands = [];
      await ensureLocalDatabase({ root, env: {}, dependencies: {
        ensurePostgres: async () => bin, occupied: async () => true, clientFactory: fakeClient(data).factory,
        runCommand: async file => { commands.push(path.basename(file)); return 'postgres (PostgreSQL) 18.6'; }
      } });
      assert.deepEqual(commands, ['postgres.exe'], `no initdb when ${evidence} exists`);
      assert.deepEqual((await readdir(path.join(root, 'data'))).filter(name => name.includes('incomplete')), []);
    }
  }));

test('unbindable saved port moves a launcher-owned cluster to a new port once', async () =>
  fixture(async ({ root, bin, data }) => {
    const env = {};
    const starts = [];
    const run = syntheticInitdb(data);
    const ports = [21951, 21952];
    const result = await ensureLocalDatabase({ root, env, dependencies: {
      ensurePostgres: async () => bin, occupied: async () => false, freePort: async () => ports.shift(),
      clientFactory: fakeClient(data, { provision: true }).factory,
      runCommand: async (file, args, timeout, log) => {
        if (file.endsWith('pg_ctl.exe')) {
          starts.push(args[args.indexOf('-o') + 1]);
          assert.equal(args[args.indexOf('-t') + 1], '120');
          assert(timeout > 120_000);
          assert.match(log, /pg_ctl\.log$/);
          if (starts.length === 1) throw new Error('synthetic bind failure');
        }
        return run(file, args, timeout, log);
      }
    } });
    assert.deepEqual(starts, ['-h 127.0.0.1 -p 21951', '-h 127.0.0.1 -p 21952']);
    assert.equal(result.port, 21952);
    assert.equal(JSON.parse(await readFile(path.join(root, 'data', 'local-database.json'), 'utf8')).port, 21952);
    assert(env.DATABASE_URL.includes('@127.0.0.1:21952/'));
  }));

test('fresh PostgreSQL port comes from the fixed range below the Windows ephemeral ports', async () => {
  const tried = [];
  const values = [0, 0.5, 0.999999];
  const port = await freePort({ random: () => values.shift(), canBind: async candidate => {
    tried.push(candidate); return tried.length === 3;
  } });
  assert.deepEqual(tried, [20_000, 30_000, 39_999]);
  assert.equal(port, 39_999);
  assert.equal(await freePort({ canBind: async () => false, attempts: 3 }), null);
  const real = await freePort();
  assert(real >= 20_000 && real < 40_000);
});

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

test('quiet PostgreSQL helper sends output to a private log file handle when one is given', async () =>
  fixture(async ({ root }) => {
    const log = path.join(root, '.local', 'postgresql', 'initdb.log');
    const child = new EventEmitter();
    child.kill = () => {};
    const result = runQuietCommand('initdb.exe', [], 100, (_file, _args, options) => {
      assert(Array.isArray(options.stdio));
      assert.equal(options.stdio[0], 'ignore');
      assert.equal(typeof options.stdio[1], 'number');
      assert.equal(options.stdio[1], options.stdio[2]);
      queueMicrotask(() => child.emit('exit', 0));
      return child;
    }, log);
    assert.equal(await result, '');
    assert(existsSync(log));
  }));
