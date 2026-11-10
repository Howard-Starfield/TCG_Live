import { createHash } from 'node:crypto';
import { constants, existsSync } from 'node:fs';
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

export async function ensureLocalSettings(root, copy = copyFile) {
  try { await copy(path.join(root, '.env.example'), path.join(root, '.env'), constants.COPYFILE_EXCL); }
  catch (error) {
    if (error.code !== 'EEXIST') throw new Error('TCG Live needs a writable application folder to save local settings. Move it to a folder owned by your Windows account and retry.');
  }
}

/** Called only after the launcher owns this checkout, so npm cannot race another launch/build. */
export async function ensureDependencies(root, install, {
  exists = existsSync, read = readFile, write = writeFile, move = rename, makeDirectory = mkdir,
  version = process.versions.node, platform = process.platform, arch = process.arch,
  log = message => process.stdout.write(message + '\n')
} = {}) {
  const lock = await read(path.join(root, 'package-lock.json'));
  const signature = createHash('sha256').update(lock).update(`${version}:${platform}:${arch}`).digest('hex');
  const marker = path.join(root, '.local', 'runtime', 'dependencies.json');
  let prior;
  try { prior = JSON.parse(await read(marker, 'utf8')); } catch { /* First run, interrupted install, or changed checkout. */ }
  const ready = ['pg', 'typescript', 'vite'].every(name => exists(path.join(root, 'node_modules', name, 'package.json')));
  if (ready && prior?.signature === signature) return false;
  log('Preparing application dependencies (first launch or application update)...');
  try { await install(); }
  catch { throw new Error('Application dependency setup failed. Check internet/proxy access and free disk space, then run Start TCG Live again. Existing database files were kept.'); }
  await makeDirectory(path.dirname(marker), { recursive: true });
  const temporary = marker + '.tmp';
  await write(temporary, JSON.stringify({ signature }), { mode: 0o600 });
  await move(temporary, marker);
  return true;
}
