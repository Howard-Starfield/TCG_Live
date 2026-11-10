import { randomBytes, createHash, createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, unlink } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDependencies, ensureLocalSettings } from './dependencies.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const INSTANCE = path.join(ROOT, 'data', 'guided-instance.json');
const ID = /^[A-Za-z0-9_-]{32,64}$/;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export function supportedNode(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!match && Number(match[1]) === 24 && (Number(match[2]) > 15 ||
    (Number(match[2]) === 15 && Number(match[3]) >= 0));
}

export function parseLauncherArgs(args) {
  if (args.some(arg => arg !== '--no-browser')) throw new Error('Unknown guided launch option.');
  return { noBrowser: args.includes('--no-browser') };
}

export function ownedRecord(value, root, port) {
  return !!value && typeof value === 'object' && value.version === 1 &&
    value.projectRoot === root && value.port === port && Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.instanceId === 'string' && ID.test(value.instanceId) &&
    typeof value.secret === 'string' && ID.test(value.secret);
}

export function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

export async function portOccupied(port) {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = occupied => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(occupied);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(700, () => finish(false));
  });
}

export async function probeOwned(record) {
  const challenge = randomBytes(24).toString('base64url');
  const expected = createHmac('sha256', record.secret)
    .update(`${record.instanceId}:${challenge}`).digest('base64url');
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}/api/v1/launcher/open`, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(1_500),
      headers: { Origin: `http://127.0.0.1:${record.port}`, 'Content-Type': 'application/json',
        'X-TCG-Instance-Key': record.secret },
      body: JSON.stringify({ challenge })
    });
    if (response.status !== 200) return null;
    const body = await response.json();
    if (body?.instanceId !== record.instanceId || body?.proof !== expected ||
        typeof body.present !== 'boolean') return null;
    if (!body.present && !new RegExp(`^http://127\\.0\\.0\\.1:${record.port}/#login=[A-Za-z0-9_-]{43}$`)
      .test(body.loginUrl ?? '')) return null;
    return body;
  } catch { return null; }
}

export function openDefaultBrowser(url, platform = process.platform, launch = spawn) {
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}\/\#login=[A-Za-z0-9_-]{43}$/.test(url)) return;
  const command = platform === 'win32' ? 'rundll32.exe' : platform === 'darwin' ? 'open' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    const child = launch(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch { /* The printed console link remains available. */ }
}

async function readRecord(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch { return null; }
}

async function releaseOwned(file, record) {
  const current = await readRecord(file);
  if (current?.instanceId === record.instanceId && current.secret === record.secret && current.pid === process.pid)
    await unlink(file).catch(() => {});
}

/** OS-bound reclaim mutex, released automatically on crash/reboot. No stale mutex file to race-unlink. */
export async function withRecoveryMutex(root, action) {
  const hash = createHash('sha256').update(root).digest();
  let server;
  for (let attempt = 0; attempt < 8; attempt++) {
    const port = 40_000 + (hash.readUInt16BE(0) + attempt * 997) % 20_000;
    const candidate = net.createServer();
    try {
      await new Promise((resolve, reject) => {
        candidate.once('error', reject);
        candidate.listen(port, '127.0.0.1', () => { candidate.off('error', reject); resolve(); });
      });
      server = candidate;
      break;
    } catch (error) {
      if (error.code === 'EADDRINUSE') return false;
      if (error.code !== 'EACCES' || attempt === 7) throw error;
    }
  }
  try { await action(); return true; }
  finally { await new Promise(resolve => server.close(resolve)); }
}

async function reclaimStale(file, old, alive, sleep, root, recoveryMutex) {
  const acquired = await recoveryMutex(root, async () => {
    const current = await readRecord(file);
    if (current?.instanceId === old.instanceId && current.secret === old.secret && !alive(old.pid))
      await unlink(file).catch(() => {});
  });
  if (!acquired) await sleep(300);
}

/** Atomic gate before any build. A live unknown owner or occupied port is never treated as ours. */
export async function claimOrReuse({ root = ROOT, file = INSTANCE,
  port, probe = probeOwned, alive = pidAlive, occupied = portOccupied,
  openBrowser = openDefaultBrowser, sleep = pause, recoveryMutex = withRecoveryMutex, maxWaitMs = 90_000,
  now = Date.now } = {}) {
  const record = { version: 1, projectRoot: root, pid: process.pid, port,
    instanceId: randomBytes(24).toString('base64url'), secret: randomBytes(32).toString('base64url') };
  await mkdir(path.dirname(file), { recursive: true });
  const deadline = now() + maxWaitMs;
  while (true) {
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const existing = await readRecord(file);
      if (!existing) {
        if (now() >= deadline) throw new Error('A guided launch record is unreadable. Review data/guided-instance.json locally.');
        await sleep(300); continue;
      }
      if (!ownedRecord(existing, root, port))
        throw new Error('A different or invalid guided instance record exists. No build was started.');
      const answer = await probe(existing);
      if (answer) {
        if (!answer.present) openBrowser(answer.loginUrl);
        return { reused: true, present: answer.present };
      }
      if (!alive(existing.pid)) {
        if (now() >= deadline) throw new Error('A stale guided launch could not be recovered. Check for another launcher using this checkout.');
        await reclaimStale(file, existing, alive, sleep, root, recoveryMutex);
        continue;
      }
      if (now() >= deadline) throw new Error('The existing guided owner did not answer its identity check. No build was started.');
      await sleep(500);
      continue;
    }
    try { await handle.writeFile(JSON.stringify(record)); }
    finally { await handle.close(); }
    if (await occupied(port)) {
      await releaseOwned(file, record);
      throw new Error('The dashboard port is occupied by an unverified process. No build was started.');
    }
    return { reused: false, record, release: () => releaseOwned(file, record) };
  }
}

async function runNpm(cli, args) {
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: ROOT, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('The web/server build failed.')));
  });
}

export async function runOwnedLaunch(claim, { build, start, stopped, isStopping }) {
  let handle;
  try {
    await build();
    if (isStopping()) return;
    handle = await start();
    if (!isStopping()) await stopped;
  } finally {
    try { await handle?.stop(); }
    finally { await claim.release(); }
  }
}

export async function prepareApplication({ root, cli, run = runNpm, database, migrate,
  dependencies = ensureDependencies, isStopping = () => false }) {
  await dependencies(root, () => run(cli, ['ci', '--no-audit', '--no-fund']));
  if (isStopping()) return;
  const local = await database();
  if (isStopping()) return;
  await run(cli, ['run', 'build:all']);
  if (isStopping()) return;
  if (local.managed) await migrate();
}

async function prepareSchema() {
  process.stdout.write('Checking local database schema and application updates...\n');
  try {
    const store = await import('../apps/server/dist/rehearsal/store.js');
    await store.setupRehearsalSchema();
    await store.setupPrivateDiscordSchema();
    const { setupTournamentDirectory } = await import('../apps/server/dist/tournaments/directory.js');
    await setupTournamentDirectory();
  } catch {
    throw new Error('Local database setup could not complete. Existing data was kept; check free disk space and the local PostgreSQL log before retrying. No database reset was attempted.');
  }
}

function npmCli() {
  const candidate = process.env.TCG_NPM_CLI || process.env.npm_execpath ||
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!existsSync(candidate)) throw new Error('npm CLI is missing. Install npm 11.9.x or use the Windows launcher.');
  return candidate;
}

async function main() {
  const { noBrowser } = parseLauncherArgs(process.argv.slice(2));
  if (!supportedNode(process.versions.node)) throw new Error('Node.js 24.15.0 or newer within 24.x is required.');
  process.chdir(ROOT);
  await ensureLocalSettings(ROOT);
  if (existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));
  const rawPort = process.env.PORT || '3000';
  if (!/^[1-9]\d{0,4}$/.test(rawPort) || Number(rawPort) > 65535) throw new Error('PORT must be 1–65535.');
  const port = Number(rawPort);
  const claim = await claimOrReuse({ port, openBrowser: noBrowser ? () => {} : openDefaultBrowser });
  if (claim.reused) {
    process.stdout.write(claim.present ? 'TCG Live is already open.\n' : 'Opened the existing TCG Live dashboard.\n');
    return;
  }
  let stopResolve;
  const stopped = new Promise(resolve => { stopResolve = resolve; });
  let stopping = false;
  const shutdown = () => { if (stopping) return; stopping = true; stopResolve(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGBREAK', shutdown);
  await runOwnedLaunch(claim, {
    build: async () => {
      const cli = npmCli();
      await prepareApplication({ root: ROOT, cli, isStopping: () => stopping,
        database: async () => {
          // pg is loaded only after npm ci on a fresh installation.
          const { ensureLocalDatabase } = await import('./local-database.mjs');
          return ensureLocalDatabase({ root: ROOT, env: process.env });
        }, migrate: prepareSchema });
    },
    start: async () => {
      const { runGuidedStart } = await import('../apps/server/dist/onboarding/entry.js');
      return runGuidedStart({ noBrowser, launcher: { instanceId: claim.record.instanceId,
        secret: claim.record.secret } });
    },
    stopped, isStopping: () => stopping
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void main().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Guided launch failed.'}\n`);
    process.exitCode = 1; });
