import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIN_NODE = [24, 15, 0];

function versionParts(raw) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(raw.trim());
  return match ? match.slice(1).map(Number) : null;
}

function compareVersions(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function pathEntries(env) {
  return (env.Path || env.PATH || '').split(path.delimiter).filter(Boolean);
}

/** The bootstrap may itself run on Node 24.14; only the selected child builds the app. */
export function findNode(env = process.env, { exists = existsSync, list = readdirSync,
  probe = executable => spawnSync(executable, ['-p', 'process.versions.node'],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 }) } = {}) {
  const candidates = [env.TCG_NODE_EXE, process.execPath,
    ...pathEntries(env).map(folder => path.join(folder, 'node.exe'))];
  const cache = path.join(env.USERPROFILE || '', '.cache', 'codex-runtimes');
  if (env.USERPROFILE && exists(cache)) {
    try {
      for (const item of list(cache, { withFileTypes: true })) {
        if (item.isDirectory()) candidates.push(path.join(cache, item.name, 'dependencies', 'node', 'bin', 'node.exe'));
      }
    } catch { /* Optional runtime cache is unavailable. */ }
  }
  let selected = null;
  for (const candidate of new Set(candidates.filter(Boolean).map(value => path.resolve(value)))) {
    if (!exists(candidate)) continue;
    try {
      const result = probe(candidate);
      const version = result.status === 0 ? versionParts(result.stdout || '') : null;
      if (version?.[0] !== 24 || compareVersions(version, MIN_NODE) < 0) continue;
      if (!selected || compareVersions(version, selected.version) > 0) selected = { executable: candidate, version };
    } catch { /* Ignore an unusable candidate. */ }
  }
  if (!selected) throw new Error('Node.js 24.15.0 or newer within 24.x is required. Install it, or set TCG_NODE_EXE.');
  return selected.executable;
}

export function findNpmCli(nodeExe, env = process.env, { exists = existsSync,
  probe = (executable, cli) => spawnSync(executable, [cli, '--version'],
    { encoding: 'utf8', windowsHide: true, timeout: 5_000 }) } = {}) {
  const npmRelative = path.join('node_modules', 'npm', 'bin', 'npm-cli.js');
  const candidates = [env.TCG_NPM_CLI, env.npm_execpath,
    path.join(path.dirname(nodeExe), npmRelative),
    ...pathEntries(env).map(folder => path.join(folder, npmRelative))];
  for (const candidate of new Set(candidates.filter(Boolean).map(value => path.resolve(value)))) {
    if (!exists(candidate)) continue;
    try {
      const result = probe(nodeExe, candidate);
      const version = result.status === 0 ? versionParts(result.stdout || '') : null;
      if (version?.[0] === 11 && compareVersions(version, [11, 9, 0]) >= 0) return candidate;
    } catch { /* Keep searching installed npm locations. */ }
  }
  throw new Error('npm 11.9.x is required. Install it alongside Node.js, or set TCG_NPM_CLI.');
}

export async function startWindows(args = process.argv.slice(2), env = process.env,
  { chooseNode = findNode, chooseNpm = findNpmCli, launch = spawn, signals = process } = {}) {
  if (args.some(arg => arg !== '--no-browser')) throw new Error('Unknown guided launch option.');
  const nodeExe = chooseNode(env);
  const npmCli = chooseNpm(nodeExe, env);
  const nodeDir = path.dirname(nodeExe);
  const childEnv = { ...env, Path: `${nodeDir}${path.delimiter}${env.Path || env.PATH || ''}`,
    PATH: `${nodeDir}${path.delimiter}${env.PATH || env.Path || ''}`, TCG_NPM_CLI: npmCli };
  const child = launch(nodeExe, [path.join(ROOT, 'scripts', 'guided-launch.mjs'), ...args],
    { cwd: ROOT, env: childEnv, stdio: 'inherit', windowsHide: false });
  return new Promise((resolve, reject) => {
    // Windows sends console Ctrl+C to both processes. Keep the bootstrap alive
    // until the child has drained its Discord runtime and released its record.
    const holdConsoleSignal = () => {};
    signals.on('SIGINT', holdConsoleSignal);
    signals.on('SIGBREAK', holdConsoleSignal);
    const cleanup = () => {
      signals.off('SIGINT', holdConsoleSignal);
      signals.off('SIGBREAK', holdConsoleSignal);
    };
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolve(code ?? (signal ? 1 : 1)); });
  });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  void startWindows().then(code => { process.exitCode = code; })
    .catch(error => { process.stderr.write(`${error instanceof Error ? error.message : 'Windows launch failed.'}\n`);
      process.exitCode = 1; });
