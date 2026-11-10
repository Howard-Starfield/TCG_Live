import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const DATABASE = 'tcg_rehearsal';
const HOST = '127.0.0.1';
const ADMIN = 'tcg_local_admin';
const APP = 'tcg_rehearsal';
const DATA_RELATIVE = path.join('data', 'postgres');
const BIN_RELATIVE = path.join('.local', 'postgresql', 'pgsql', 'bin');
const MARKER = 'tcg-live-local-postgres';
const PORT_ERROR = 'The managed PostgreSQL port is occupied by an unverified server.';
const OWNERSHIP_ERROR = 'The selected PostgreSQL cluster does not belong to this TCG Live checkout.';
const CREDENTIAL_ERROR = 'The managed PostgreSQL credentials or database could not be verified.';
const VERSION_ERROR = 'The managed PostgreSQL data and binary versions are incompatible.';

const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
const validPort = value => Number.isInteger(Number(value)) && Number(value) >= 1 && Number(value) <= 65_535;
const safePassword = () => randomBytes(32).toString('base64url');

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new Error('Managed PostgreSQL metadata is unreadable; review the local database files.');
  }
}

async function saveManagedRecord(file, record, root) {
  const scratch = path.join(root, '.local', 'postgresql',
    '.managed-record-' + randomBytes(12).toString('hex') + '.tmp');
  await mkdir(path.dirname(scratch), { recursive: true });
  let handle;
  try {
    handle = await open(scratch, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(record));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(scratch, file); // Atomic exclusive publication; never replace saved credentials.
  } catch {
    throw new Error('Managed PostgreSQL credentials could not be saved safely.');
  } finally {
    await handle?.close().catch(() => {});
    await unlink(scratch).catch(() => {});
  }
}

async function command(file, args, timeout = 25_000) {
  try {
    if (['pg_ctl.exe', 'initdb.exe'].includes(path.basename(file).toLowerCase()))
      return await runQuietCommand(file, args, timeout);
    const result = await execute(file, args, { windowsHide: true, timeout, maxBuffer: 256 * 1024 });
    return result.stdout;
  } catch {
    throw new Error('The local PostgreSQL command failed; review its private server log.');
  }
}

export async function runQuietCommand(file, args, timeout, launch = spawn) {
  return new Promise((resolve, reject) => {
    let child;
    try { child = launch(file, args, { windowsHide: true, stdio: 'ignore' }); }
    catch { reject(new Error('The local PostgreSQL command failed.')); return; }
    let settled = false;
    const finish = ok => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (ok) resolve('');
      else reject(new Error('The local PostgreSQL command failed.'));
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* The helper may have exited already. */ }
      // Only this spawned helper, never an arbitrary PostgreSQL PID.
      finish(false);
    }, timeout);
    child.once('error', () => finish(false));
    child.once('exit', code => finish(code === 0));
  });
}

async function occupied(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: HOST, port });
    let done = false;
    const finish = value => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(750, () => finish(false));
  });
}

async function freePort() {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' ? address.port : null;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function createClient(config) {
  const { default: pg } = await import('pg');
  return new pg.Client({
    host: HOST, port: Number(config.port), database: config.database,
    user: config.user, password: config.password, ssl: false,
    connectionTimeoutMillis: 2_000, query_timeout: 2_500,
    statement_timeout: 2_000, options: '-c statement_timeout=2000'
  });
}

async function withClient(config, clientFactory, action) {
  const client = await clientFactory(config);
  client.on?.('error', () => {});
  let timer;
  try {
    await client.connect();
    return await action(client);
  } catch {
    throw new Error(CREDENTIAL_ERROR);
  } finally {
    await Promise.race([
      Promise.resolve().then(() => client.end()).catch(() => {}),
      new Promise(resolve => { timer = setTimeout(resolve, 2_000); })
    ]);
    if (timer) clearTimeout(timer);
    client.connection?.stream?.destroy?.();
  }
}

function connectionUrl(record) {
  const url = new URL('postgresql://127.0.0.1');
  url.port = String(record.port);
  url.username = record.user;
  url.password = record.password;
  url.pathname = '/' + DATABASE;
  return url.href;
}

function matchingUrl(raw, record) {
  try {
    const url = new URL(raw);
    return ['postgres:', 'postgresql:'].includes(url.protocol) && url.hostname === HOST &&
      url.port === String(record.port) && decodeURIComponent(url.username) === record.user &&
      decodeURIComponent(url.password) === record.password &&
      decodeURIComponent(url.pathname) === '/' + DATABASE && !raw.includes('?') && !raw.includes('#');
  } catch { return false; }
}

function validRecord(record, root, dataDirectory, source) {
  return !!record && typeof record === 'object' && record.host === HOST &&
    record.database === DATABASE && validPort(record.port) &&
    typeof record.user === 'string' && !!record.user &&
    typeof record.password === 'string' && !!record.password &&
    typeof record.adminUser === 'string' && !!record.adminUser &&
    typeof record.adminPassword === 'string' && !!record.adminPassword &&
    (source === 'legacy' ? samePath(record.dataDirectory ?? '', dataDirectory) :
      record.version === 1 && record.marker === MARKER &&
      record.dataDirectory === DATA_RELATIVE && record.binDirectory === BIN_RELATIVE);
}

async function assertOwnedDirectory(dataDirectory) {
  const actual = await realpath(dataDirectory);
  if (!samePath(actual, dataDirectory) || (await lstat(dataDirectory)).isSymbolicLink())
    throw new Error(OWNERSHIP_ERROR);
}

async function verifyVersion(dataDirectory, binDirectory, run) {
  let dataVersion;
  try { dataVersion = (await readFile(path.join(dataDirectory, 'PG_VERSION'), 'utf8')).trim(); }
  catch { throw new Error(VERSION_ERROR); }
  const binary = await run(path.join(binDirectory, 'postgres.exe'), ['--version'], 5_000);
  const match = /PostgreSQL\)?\s+(\d+)(?:\.\d+)?/.exec(binary);
  if (!match || match[1] !== dataVersion || dataVersion !== '18') throw new Error(VERSION_ERROR);
}

async function verifyOwnership(record, dataDirectory, clientFactory) {
  await withClient({ ...record, database: 'postgres', user: record.adminUser,
    password: record.adminPassword }, clientFactory, async client => {
    const result = await client.query('SHOW data_directory');
    if (!samePath(result.rows[0]?.data_directory ?? '', dataDirectory))
      throw new Error(OWNERSHIP_ERROR);
    const version = await client.query('SHOW server_version');
    if (!/^18(?:\.|$)/.test(version.rows[0]?.server_version ?? ''))
      throw new Error(VERSION_ERROR);
    const listeners = await client.query('SHOW listen_addresses');
    if (!['127.0.0.1', 'localhost', '::1'].includes((listeners.rows[0]?.listen_addresses ?? '').trim()))
      throw new Error(OWNERSHIP_ERROR);
  });
}

async function verifyApp(record, clientFactory) {
  await withClient(record, clientFactory, async client => {
    const result = await client.query(
      'SELECT current_database() AS database, current_user AS username, r.rolsuper AS superuser ' +
      'FROM pg_roles r WHERE r.rolname = current_user'
    );
    if (result.rows[0]?.database !== DATABASE || result.rows[0]?.username !== record.user ||
        result.rows[0]?.superuser !== false) throw new Error(CREDENTIAL_ERROR);
  });
}

async function provision(record, clientFactory) {
  await withClient({ ...record, database: 'postgres', user: record.adminUser,
    password: record.adminPassword }, clientFactory, async client => {
    const role = await client.query('SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname = $1', [APP]);
    if (!role.rows[0]) {
      // Password is generated as base64url and is never placed on a command line.
      if (!/^[A-Za-z0-9_-]+$/.test(record.password)) throw new Error(CREDENTIAL_ERROR);
      await client.query(`CREATE ROLE ${APP} LOGIN PASSWORD '${record.password}'`);
    } else if (role.rows[0].rolsuper || !role.rows[0].rolcanlogin) {
      throw new Error(CREDENTIAL_ERROR);
    }
    const database = await client.query('SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1', [DATABASE]);
    if (!database.rows[0]) await client.query(`CREATE DATABASE ${DATABASE} OWNER ${APP}`);
    else if (database.rows[0].owner !== APP) throw new Error(CREDENTIAL_ERROR);
  });
}

async function initialize(record, dataDirectory, binDirectory, run) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'tcg-pg-init-'));
  const pwfile = path.join(scratch, 'password');
  try {
    await writeFile(pwfile, record.adminPassword + '\n', { flag: 'wx', mode: 0o600 });
    try {
      await run(path.join(binDirectory, 'initdb.exe'),
        ['-D', dataDirectory, '--username=' + record.adminUser,
          '--auth-host=scram-sha-256', '--auth-local=scram-sha-256',
          '--encoding=UTF8', '--pwfile=' + pwfile], 60_000);
    } catch { throw new Error('The local PostgreSQL initialization failed; saved credentials were preserved.'); }
  } finally {
    await unlink(pwfile).catch(() => {});
    await rmdir(scratch).catch(() => {});
  }
}

/**
 * Only this checkout's verified data/postgres cluster is started. An explicit
 * unrelated DATABASE_URL is left entirely to the caller.
 */
export async function ensureLocalDatabase({ root, env = process.env, dependencies = {} }) {
  const projectRoot = path.resolve(root);
  const dataDirectory = path.join(projectRoot, DATA_RELATIVE);
  const metadataPath = path.join(projectRoot, 'data', 'local-database.json');
  const legacyPath = path.join(projectRoot, '.local', 'postgresql', 'credentials.json');
  const expectedBin = path.join(projectRoot, BIN_RELATIVE);
  const explicit = env.DATABASE_URL?.trim();
  let metadata;
  try { metadata = await readJson(metadataPath); }
  catch { if (!explicit) throw new Error('Managed PostgreSQL metadata is unreadable; review the local database files.'); }
  let legacy;
  if (explicit && !matchingUrl(explicit, metadata)) {
    try { legacy = await readJson(legacyPath); }
    catch { /* An unrelated explicit URL is not managed by this launcher. */ }
  } else if (!metadata) legacy = await readJson(legacyPath);
  if (explicit && !matchingUrl(explicit, metadata) && !matchingUrl(explicit, legacy))
    return { managed: false };
  const source = metadata && (!explicit || matchingUrl(explicit, metadata)) ? 'managed' : legacy ? 'legacy' : null;
  const saved = source === 'managed' ? metadata : source === 'legacy' ? legacy : null;
  if (saved && !validRecord(saved, projectRoot, dataDirectory, source))
    throw new Error('Managed PostgreSQL metadata does not match this checkout.');
  const ensurePostgres = dependencies.ensurePostgres ??
    (async selectedRoot => (await import('./runtime-downloads.mjs')).ensurePostgres(selectedRoot));
  const run = dependencies.runCommand ?? command;
  const isOccupied = dependencies.occupied ?? occupied;
  const selectPort = dependencies.freePort ?? freePort;
  const clientFactory = dependencies.clientFactory ?? createClient;
  let binDirectory;
  try { binDirectory = dependencies.runtimeBinDirectory ?? await ensurePostgres(projectRoot); }
  catch (error) {
    if (error?.code === 'TCG_RUNTIME_SETUP' && typeof error.message === 'string') throw error;
    throw new Error('The local PostgreSQL runtime could not be installed or verified.');
  }
  if (!dependencies.runtimeBinDirectory && !samePath(binDirectory, expectedBin))
    throw new Error('PostgreSQL runtime is outside this checkout.');
  try { await assertOwnedDirectory(binDirectory); }
  catch { throw new Error('PostgreSQL runtime is outside this checkout.'); }
  let record = saved;
  if (!record) {
    let entries;
    try { entries = await readdir(dataDirectory); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Managed PostgreSQL data directory is unreadable.');
      entries = [];
    }
    if (entries.length) throw new Error('Existing PostgreSQL data has no matching managed credentials; it was not changed.');
    const port = await selectPort();
    if (!validPort(port)) throw new Error('No safe local PostgreSQL port is available.');
    record = {
      version: 1, marker: MARKER, dataDirectory: DATA_RELATIVE,
      binDirectory: BIN_RELATIVE, host: HOST, port,
      database: DATABASE, adminUser: ADMIN, adminPassword: safePassword(),
      user: APP, password: safePassword()
    };
    await mkdir(path.dirname(dataDirectory), { recursive: true });
    await saveManagedRecord(metadataPath, record, projectRoot);
    await initialize(record, dataDirectory, binDirectory, run);
  } else if (source === 'managed') {
    let hasVersion = true;
    try { await readFile(path.join(dataDirectory, 'PG_VERSION'), 'utf8'); }
    catch (error) {
      if (error?.code !== 'ENOENT') throw new Error('Managed PostgreSQL data is unreadable.');
      hasVersion = false;
    }
    if (!hasVersion) {
      let entries;
      try { entries = await readdir(dataDirectory); }
      catch (error) {
        if (error?.code !== 'ENOENT') throw new Error('Managed PostgreSQL data is unreadable.');
        entries = [];
      }
      if (entries.length) throw new Error('Partial PostgreSQL data was preserved for manual review; it was not reinitialized.');
      await initialize(record, dataDirectory, binDirectory, run);
    }
  }
  await assertOwnedDirectory(dataDirectory);
  await verifyVersion(dataDirectory, binDirectory, run);
  const wasOccupied = await isOccupied(record.port);
  if (!wasOccupied) {
    try {
      await run(path.join(binDirectory, 'pg_ctl.exe'),
        ['-D', dataDirectory, '-l', path.join(projectRoot, '.local', 'postgresql', 'server.log'),
          '-o', `-h ${HOST} -p ${record.port}`, '-w', '-t', '20', 'start'], 30_000);
    } catch { throw new Error('The managed PostgreSQL cluster could not be started; review its private log.'); }
  }
  try { await verifyOwnership(record, dataDirectory, clientFactory); }
  catch { throw new Error(wasOccupied ? PORT_ERROR : OWNERSHIP_ERROR); }
  if (source === 'managed' || !source) await provision(record, clientFactory);
  try { await verifyApp(record, clientFactory); }
  catch { throw new Error(CREDENTIAL_ERROR); }
  if (!explicit) env.DATABASE_URL = connectionUrl(record);
  return { managed: true, port: Number(record.port), dataDirectory, binDirectory,
    started: !wasOccupied };
}
