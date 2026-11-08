import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { spawn } from 'node:child_process';
import { openDefaultBrowser } from './entry.js';

test('default-browser opener uses an argument list for a private loopback link and ignores foreign URLs', () => {
  const launches: Array<{ command: string; args: string[]; options: unknown }> = [];
  const launch = ((command: string, args: string[], options: unknown) => {
    launches.push({ command, args, options });
    return { on() { return this; }, unref() {} };
  }) as unknown as typeof spawn;
  const url = `http://127.0.0.1:3000/#login=${'a'.repeat(43)}`;
  openDefaultBrowser(url, 'win32', launch);
  openDefaultBrowser('https://example.com/#login=secret', 'win32', launch);
  assert.equal(launches.length, 1);
  assert.equal(launches[0]?.command, 'rundll32.exe');
  assert.deepEqual(launches[0]?.args, ['url.dll,FileProtocolHandler', url]);
  assert.deepEqual(launches[0]?.options, { detached: true, stdio: 'ignore', windowsHide: true });
});
