import { createHash, randomUUID } from 'node:crypto';
import { execFile as callbackExecFile, spawnSync } from 'node:child_process';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(callbackExecFile);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(new URL('./runtime-manifest.json', import.meta.url), 'utf8'));
const POSTGRES = manifest.postgres;
const VC_RUNTIME = manifest.vcRuntime;
const MISSING_DLL = -1073741515;

export class RuntimeSetupError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuntimeSetupError';
    this.code = 'TCG_RUNTIME_SETUP';
  }
}

export function isMissingDllExit(status) {
  return status === MISSING_DLL || status === 0xC0000135;
}

export function validateArchiveEntries(names, folder = 'pgsql') {
  if (!Array.isArray(names) || !names.length || names.length > 100_000) throw new Error('PostgreSQL archive has an invalid file list.');
  for (const raw of names) {
    if (typeof raw !== 'string' || !raw.startsWith(`${folder}/`) || raw.includes('\\') || raw.includes(':') ||
        raw.split('/').some(part => part === '..' || part === '.') || raw.length > 1_024)
      throw new Error('PostgreSQL archive contains an unsafe path.');
  }
}

export async function verifyArchive(file, artifact = POSTGRES) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(file)) {
    size += chunk.length;
    if (size > artifact.size) throw new RuntimeSetupError('Private runtime download is larger than its pinned artifact.');
    hash.update(chunk);
  }
  if (size !== artifact.size || hash.digest('hex') !== artifact.sha256)
    throw new RuntimeSetupError('Private runtime download checksum or size did not match. No runtime was installed.');
}

export async function downloadArchive(file, artifact = POSTGRES,
  { fetchImpl = fetch, write = text => process.stderr.write(text), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    lastError = null;
    const handle = await open(file, 'wx', 0o600);
    try {
      write(`TCG Live: downloading private PostgreSQL ${artifact.version} (${Math.ceil(artifact.size / 1024 / 1024)} MiB), attempt ${attempt}/3.\n`);
      const response = await fetchImpl(artifact.url, { redirect: 'follow', signal: AbortSignal.timeout(600_000) });
      if (!response.ok || !response.body) throw new Error('PostgreSQL download did not complete.');
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > 0 && declared !== artifact.size)
        throw new Error('PostgreSQL download size differs from the pinned archive.');
      const hash = createHash('sha256');
      let size = 0;
      let nextProgress = Math.ceil(artifact.size / 4);
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > artifact.size) throw new RuntimeSetupError('Private runtime download is larger than its pinned artifact.');
        hash.update(chunk);
        await handle.write(chunk);
        if (size >= nextProgress) {
          write(`TCG Live: PostgreSQL download ${Math.floor(size / artifact.size * 100)}%.\n`);
          nextProgress += Math.ceil(artifact.size / 4);
        }
      }
      if (size !== artifact.size || hash.digest('hex') !== artifact.sha256)
        throw new RuntimeSetupError('Private runtime download checksum or size did not match. No runtime was installed.');
      lastError = null;
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await handle.close();
      if (lastError) await unlink(file).catch(() => {});
    }
    if (attempt < 3) await sleep(2_000 * attempt);
  }
  throw lastError ?? new Error('PostgreSQL download failed.');
}

export async function probePostgresDetailed(bin, version = '18.6',
  { exists = existsSync, spawn = spawnSync } = {}) {
  for (const tool of ['postgres', 'initdb', 'pg_ctl', 'psql']) {
    const executable = path.join(bin, `${tool}.exe`);
    if (!exists(executable)) return { ok: false, missingDll: false };
    const result = spawn(executable, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 5_000 });
    if (isMissingDllExit(result.status)) return { ok: false, missingDll: true };
    if (result.status !== 0 || !new RegExp(`\\b${version.replace('.', '\\.')}\\b`).test(result.stdout || ''))
      return { ok: false, missingDll: false };
  }
  return { ok: true, missingDll: false };
}

export async function probePostgres(bin, version = '18.6', options) {
  return (await probePostgresDetailed(bin, version, options)).ok;
}

/** Only called after PostgreSQL reports the Windows missing-DLL status. */
export async function installVcRuntime(root = ROOT, {
  artifact = VC_RUNTIME, fetchImpl = fetch, write = text => process.stderr.write(text),
  run = spawnSync
} = {}) {
  const cacheRoot = path.join(path.resolve(root), '.local', 'runtime');
  await mkdir(cacheRoot, { recursive: true });
  const installer = path.join(cacheRoot, artifact.file);
  if (existsSync(installer)) {
    try { await verifyArchive(installer, artifact); }
    catch { throw new RuntimeSetupError('Cached Microsoft Visual C++ installer checksum is invalid. Move .local/runtime/vc_redist.x64.exe aside and retry.'); }
  } else {
    const temporary = path.join(cacheRoot, `.vc-redist-${randomUUID()}.exe`);
    try {
      write('TCG Live: downloading the verified Microsoft Visual C++ x64 runtime.\n');
      try {
        await downloadArchive(temporary, artifact, { fetchImpl,
          write: () => {}, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) });
      } catch {
        throw new RuntimeSetupError('Microsoft Visual C++ installer download failed or failed checksum verification. Check the connection and retry.');
      }
      await rename(temporary, installer);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  const script = fileURLToPath(new URL('./install-vc-runtime.ps1', import.meta.url));
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Installer', installer, '-Sha256', artifact.sha256];
  write('TCG Live: Windows may ask for approval to install the Microsoft runtime.\n');
  let result = run('pwsh.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  if (result.error?.code === 'ENOENT')
    result = run('powershell.exe', args, { encoding: 'utf8', windowsHide: true, timeout: 300_000 });
  if (result.status === 1223) throw new RuntimeSetupError('Microsoft Visual C++ runtime approval was canceled. Approve the Windows prompt and retry.');
  if (result.error) throw new RuntimeSetupError('Microsoft Visual C++ runtime setup could not start. Check PowerShell and retry.');
  if (![0, 3010, 1638].includes(result.status))
    throw new RuntimeSetupError(`Microsoft Visual C++ runtime verification or setup failed (exit ${result.status}).`);
  if (result.status === 3010)
    throw new RuntimeSetupError('Microsoft Visual C++ runtime was installed. Restart Windows, then launch TCG Live again.');
}

function ownedStage(stage, runtimeRoot) {
  const absolute = path.resolve(stage);
  if (path.dirname(absolute) !== path.resolve(runtimeRoot) || !path.basename(absolute).startsWith('.pgsql-'))
    throw new Error('Refusing to clean outside the private PostgreSQL staging folder.');
  return absolute;
}

/** Returns app-local pgsql/bin. A missing Microsoft VC++ DLL can trigger an approved elevated prerequisite install. */
export async function ensurePostgres(root = ROOT, {
  artifact = POSTGRES, archivePath = null, fetchImpl = fetch,
  listArchive = async zip => (await execFile('tar.exe', ['-tf', zip],
    { encoding: 'utf8', windowsHide: true, timeout: 90_000, maxBuffer: 32 * 1024 * 1024 })).stdout.split(/\r?\n/).filter(Boolean),
  extractArchive = async (zip, stage) => { await execFile('tar.exe', ['-xf', zip, '-C', stage],
    { windowsHide: true, timeout: 300_000 }); },
  probe = probePostgres, diagnose = probePostgresDetailed, installRuntime = installVcRuntime,
  write = text => process.stderr.write(text),
  platform = process.platform, architecture = process.arch
} = {}) {
  if (platform !== 'win32' || architecture !== 'x64') throw new Error('Private PostgreSQL supports x64 Windows only.');
  const projectRoot = path.resolve(root);
  const runtimeRoot = path.join(projectRoot, '.local', 'postgresql');
  const final = path.join(runtimeRoot, artifact.folder);
  const bin = path.join(final, 'bin');
  if (await probe(bin, artifact.version)) return bin;
  if (existsSync(final) && (await diagnose(bin, artifact.version)).missingDll) {
    await installRuntime(projectRoot, { write });
    if (await probe(bin, artifact.version)) return bin;
  }
  if (existsSync(final)) throw new RuntimeSetupError('The private PostgreSQL folder exists but is incomplete or cannot start. Check for the Microsoft Visual C++ 2015-2022 x64 runtime, then move .local/postgresql/pgsql aside and retry.');
  await mkdir(runtimeRoot, { recursive: true });
  const suffix = randomUUID();
  const stage = ownedStage(path.join(runtimeRoot, `.pgsql-${suffix}`), runtimeRoot);
  const downloaded = path.join(runtimeRoot, `.pgsql-${suffix}.zip`);
  try {
    if (archivePath) await verifyArchive(archivePath, artifact);
    else await downloadArchive(downloaded, artifact, { fetchImpl, write });
    const zip = archivePath ?? downloaded;
    validateArchiveEntries(await listArchive(zip), artifact.folder);
    await mkdir(stage, { recursive: false });
    write('TCG Live: PostgreSQL checksum verified; extracting private runtime.\n');
    await extractArchive(zip, stage);
    const staged = path.join(stage, artifact.folder);
    const stagedBin = path.join(staged, 'bin');
    if (!await probe(stagedBin, artifact.version) && (await diagnose(stagedBin, artifact.version)).missingDll)
      await installRuntime(projectRoot, { write });
    if (!await probe(stagedBin, artifact.version))
      throw new RuntimeSetupError('Private PostgreSQL could not start. Check the Microsoft Visual C++ 2015-2022 x64 runtime.');
    if (existsSync(final)) {
      if (!await probe(bin, artifact.version)) throw new Error('Another private PostgreSQL install is incomplete.');
      return bin;
    }
    await rename(staged, final);
    return bin;
  } finally {
    await unlink(downloaded).catch(() => {});
    await rm(ownedStage(stage, runtimeRoot), { recursive: true, force: true });
  }
}
