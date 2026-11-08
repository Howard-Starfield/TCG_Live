import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { test } from 'node:test';
import { findNode, findNpmCli, startWindows } from './windows-start.mjs';

test('bootstrap chooses a supported cached Node over an older PATH runtime', () => {
  const env = { USERPROFILE: 'C:\\Users\\example', Path: 'C:\\old', TCG_NODE_EXE: 'C:\\selected\\node.exe' };
  const result = findNode(env, {
    exists: file => !file.includes('node_modules') && (file.endsWith('node.exe') || file.endsWith('codex-runtimes')),
    list: () => [{ name: 'release-a', isDirectory: () => true }],
    probe: executable => ({ status: 0, stdout: executable.includes('release-a') ? '24.22.1' :
      executable.includes('selected') ? '24.15.0' : '24.14.0' })
  });
  assert.match(result, /release-a/);
  assert.throws(() => findNode({ USERPROFILE: '', Path: '' },
    { exists: () => true, probe: () => ({ status: 0, stdout: '24.14.0' }) }), /24\.15\.0/);
});

test('npm selector checks major and minimum version without executing npm.cmd', () => {
  const cli = path.resolve('C:\\npm', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  assert.equal(findNpmCli('C:\\node\\node.exe', { TCG_NPM_CLI: cli, Path: '' },
    { exists: candidate => candidate === cli, probe: () => ({ status: 0, stdout: '11.9.2' }) }), cli);
  assert.throws(() => findNpmCli('C:\\node\\node.exe', { TCG_NPM_CLI: cli, Path: '' },
    { exists: candidate => candidate === cli, probe: () => ({ status: 0, stdout: '10.9.0' }) }), /npm 11\.9/);
});

test('Windows bootstrap forwards args, selected runtime and exit status', async () => {
  const calls = [];
  const nodeExe = path.resolve('C:\\selected', 'node.exe');
  const code = await startWindows(['--no-browser'], { Path: 'C:\\old' }, {
    chooseNode: () => nodeExe, chooseNpm: () => 'C:\\npm\\npm-cli.js',
    launch: (command, args, options) => {
      calls.push({ command, args, options });
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('exit', 17, null));
      return child;
    }
  });
  assert.equal(code, 17);
  assert.equal(calls[0].command, nodeExe);
  assert.deepEqual(calls[0].args.slice(1), ['--no-browser']);
  assert.equal(calls[0].options.env.TCG_NPM_CLI, 'C:\\npm\\npm-cli.js');
  assert(calls[0].options.env.Path.startsWith(path.dirname(nodeExe)));
  await assert.rejects(startWindows(['--bad']), /Unknown guided launch option/);
});

test('console interrupt keeps bootstrap waiting for child drain and removes listeners afterward', async () => {
  const signals = new EventEmitter();
  let child;
  let finished = false;
  const running = startWindows([], { Path: 'C:\\old' }, {
    chooseNode: () => 'C:\\selected\\node.exe', chooseNpm: () => 'C:\\npm\\npm-cli.js',
    signals, launch: () => { child = new EventEmitter(); return child; }
  }).then(code => { finished = true; return code; });
  assert.equal(signals.listenerCount('SIGINT'), 1);
  assert.equal(signals.listenerCount('SIGBREAK'), 1);
  signals.emit('SIGINT');
  await Promise.resolve();
  assert.equal(finished, false);
  child.emit('exit', 0, null);
  assert.equal(await running, 0);
  assert.equal(signals.listenerCount('SIGINT'), 0);
  assert.equal(signals.listenerCount('SIGBREAK'), 0);
});
