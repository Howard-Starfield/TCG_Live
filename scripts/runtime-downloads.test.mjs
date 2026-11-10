import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { downloadArchive, ensurePostgres, installVcRuntime, isMissingDllExit,
  probePostgresDetailed, validateArchiveEntries, verifyArchive } from './runtime-downloads.mjs';

const artifactFor = bytes => ({ version: '18.6', folder: 'pgsql', url: 'https://example.invalid/archive.zip',
  size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });

async function temporary(run) {
  const root = await mkdtemp(path.join(tmpdir(), 'tcg-runtime-test-'));
  assert.equal(path.dirname(root), tmpdir());
  try { await run(root); }
  finally { await rm(root, { recursive: true, force: true }); }
}

test('archive paths stay under the expected root', () => {
  validateArchiveEntries(['pgsql/', 'pgsql/bin/postgres.exe', 'pgsql/pgAdmin 4/readme.txt']);
  for (const name of ['../outside', 'pgsql/../outside', 'pgsql/C:/outside', 'other/bin/postgres.exe',
    'pgsql\\bin\\postgres.exe']) assert.throws(() => validateArchiveEntries([name]), /unsafe/);
});

test('checksum mismatch rejects without publishing a private runtime', async () => temporary(async root => {
  const bytes = Buffer.from('verified fake zip bytes');
  const archive = path.join(root, 'source.zip');
  await writeFile(archive, Buffer.from('tampered fake zip bytes'));
  const artifact = artifactFor(bytes);
  await assert.rejects(verifyArchive(archive, artifact), /checksum or size/);
  await assert.rejects(ensurePostgres(root, { artifact, archivePath: archive,
    platform: 'win32', architecture: 'x64', probe: async () => false,
    listArchive: async () => ['pgsql/bin/postgres.exe'], extractArchive: async () => {} }), /checksum or size/);
  assert.equal(existsSync(path.join(root, '.local', 'postgresql', 'pgsql')), false);
}));

test('failed downloads retry without leaving an archive behind', async () => temporary(async root => {
  const destination = path.join(root, 'download.zip');
  let attempts = 0;
  await assert.rejects(downloadArchive(destination, artifactFor(Buffer.from('expected')),
    { fetchImpl: async () => { attempts++; throw new Error('offline'); }, write: () => {}, sleep: async () => {} }), /offline/);
  assert.equal(attempts, 3);
  assert.equal(existsSync(destination), false);
  const corrupt = Buffer.from('corrupt');
  await assert.rejects(downloadArchive(destination, artifactFor(Buffer.from('expected')),
    { fetchImpl: async () => new Response(corrupt), write: () => {}, sleep: async () => {} }), /checksum or size/);
  assert.equal(existsSync(destination), false);
}));

test('verified staged PostgreSQL publishes once and reuses the app-local bin', async () => temporary(async root => {
  const bytes = Buffer.from('verified fake zip bytes');
  const archive = path.join(root, 'source.zip');
  await writeFile(archive, bytes);
  const artifact = artifactFor(bytes);
  let extracts = 0;
  const options = { artifact, archivePath: archive, platform: 'win32', architecture: 'x64',
    listArchive: async () => ['pgsql/', 'pgsql/bin/postgres.exe'],
    extractArchive: async (_zip, stage) => {
      extracts++;
      await mkdir(path.join(stage, 'pgsql', 'bin'), { recursive: true });
      await writeFile(path.join(stage, 'pgsql', 'bin', 'postgres.exe'), 'fake');
    },
    probe: async bin => existsSync(path.join(bin, 'postgres.exe')), write: () => {} };
  const bin = await ensurePostgres(root, options);
  assert.equal(bin, path.join(root, '.local', 'postgresql', 'pgsql', 'bin'));
  assert.equal((await readFile(path.join(bin, 'postgres.exe'), 'utf8')), 'fake');
  assert.equal(await ensurePostgres(root, options), bin);
  assert.equal(extracts, 1);
  assert.deepEqual(await readdir(path.join(root, '.local', 'postgresql')), ['pgsql']);
}));

test('only Windows missing-DLL exit status requests a Microsoft runtime', async () => temporary(async root => {
  assert.equal(isMissingDllExit(-1073741515), true);
  assert.equal(isMissingDllExit(0xC0000135), true);
  assert.equal(isMissingDllExit(1), false);
  const bin = path.join(root, 'bin');
  const exists = () => true;
  assert.deepEqual(await probePostgresDetailed(bin, '18.6', { exists,
    spawn: () => ({ status: -1073741515, stdout: '' }) }), { ok: false, missingDll: true });
  assert.deepEqual(await probePostgresDetailed(bin, '18.6', { exists,
    spawn: () => ({ status: 1, stdout: '' }) }), { ok: false, missingDll: false });

  const bytes = Buffer.from('verified fake zip bytes');
  const archive = path.join(root, 'source.zip');
  await writeFile(archive, bytes);
  let installs = 0;
  let recovered = false;
  const common = { artifact: artifactFor(bytes), archivePath: archive, platform: 'win32', architecture: 'x64',
    listArchive: async () => ['pgsql/bin/postgres.exe'],
    extractArchive: async (_zip, stage) => mkdir(path.join(stage, 'pgsql', 'bin'), { recursive: true }),
    probe: async () => recovered,
    installRuntime: async () => { installs++; recovered = true; }, write: () => {} };
  await assert.rejects(ensurePostgres(root, { ...common, diagnose: async () => ({ missingDll: false }) }), /could not start/);
  assert.equal(installs, 0);
  assert.equal(existsSync(path.join(root, '.local', 'postgresql', 'pgsql')), false);
  const installed = await ensurePostgres(root, { ...common, diagnose: async () => ({ missingDll: true }) });
  assert.equal(installs, 1);
  assert.equal(installed, path.join(root, '.local', 'postgresql', 'pgsql', 'bin'));
}));

test('Microsoft runtime installer verifies download and reports canceled elevation', async () => temporary(async root => {
  const bytes = Buffer.from('test-only installer');
  const artifact = { ...artifactFor(bytes), file: 'vc_redist.x64.exe' };
  let calls = 0;
  const run = () => { calls++; return { status: 1223 }; };
  await assert.rejects(installVcRuntime(root, { artifact, fetchImpl: async () => new Response('bad'),
    run, write: () => {} }), error => error.code === 'TCG_RUNTIME_SETUP' && /checksum verification/.test(error.message));
  assert.equal(calls, 0);
  const cache = path.join(root, '.local', 'runtime', artifact.file);
  assert.equal(existsSync(cache), false);
  await assert.rejects(installVcRuntime(root, { artifact, fetchImpl: async () => new Response(bytes),
    run, write: () => {} }), error => error.code === 'TCG_RUNTIME_SETUP' && /approval was canceled/.test(error.message));
  assert.equal(calls, 1);
  assert.equal((await readFile(cache)).toString(), bytes.toString());
  await assert.rejects(installVcRuntime(root, { artifact, run: () => ({ status: 1 }), write: () => {} }),
    error => error.code === 'TCG_RUNTIME_SETUP' && /verification or setup failed/.test(error.message));
  await assert.rejects(installVcRuntime(root, { artifact, run: () => ({ status: 3010 }), write: () => {} }),
    error => error.code === 'TCG_RUNTIME_SETUP' && /Restart Windows/.test(error.message));
}));
