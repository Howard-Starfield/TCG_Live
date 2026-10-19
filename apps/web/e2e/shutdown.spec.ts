// Windows shutdown with an open stream (plan: Wave 2 gate, "Windows Ctrl+C with an open stream stops
// cleanly"). The stock demo runs in a private hidden console and gets a real console control event.
import http from 'node:http';
import { expect, test } from '@playwright/test';
import { apiLogin, expectConsole } from './support/console';
import { startDemoInConsole, type ConsoleDemo } from './support/console-ctrl';
import { startDemo } from './support/demo';

test.skip(process.platform !== 'win32', 'Console control events are Windows-specific.');
test.use({ viewport: { width: 1440, height: 900 } });

interface OpenStream { firstChange: Promise<void>; ended: Promise<{ how: 'end' | 'aborted' | 'error'; atMs: number }> }

/** Opens the event stream with a bearer token, as the console does (fetch without EventSource). */
function openStream(origin: string, bearer: string): Promise<OpenStream> {
  const url = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = http.get({ host: url.hostname, port: url.port, path: '/api/v1/stream', agent: false,
      headers: { Authorization: `Bearer ${bearer}` } }, response => {
      if (response.statusCode !== 200) { reject(new Error(`stream answered ${response.statusCode}`)); return; }
      let text = '';
      const firstChange = new Promise<void>(done => {
        response.setEncoding('utf8').on('data', (chunk: string) => { text += chunk; if (text.includes('event: change')) done(); });
      });
      const ended = new Promise<{ how: 'end' | 'aborted' | 'error'; atMs: number }>(done => {
        response.once('end', () => done({ how: 'end', atMs: Date.now() }));
        response.once('aborted', () => done({ how: 'aborted', atMs: Date.now() }));
        response.once('error', () => done({ how: 'error', atMs: Date.now() }));
      });
      resolve({ firstChange, ended });
    });
    request.once('error', reject);
  });
}

for (const kind of ['ctrl-c', 'ctrl-break'] as const) {
  test(`${kind === 'ctrl-c' ? 'Ctrl+C' : 'Ctrl+Break'} with open streams exits with code 0 within 5 s and ends the streams cleanly`, async ({ page }) => {
    test.setTimeout(90_000);
    let demo: ConsoleDemo | undefined;
    try {
      demo = await startDemoInConsole();
      // A browser tab with a live stream, plus a raw stream client.
      await page.goto(`${demo.origin}/#login=${demo.token}`);
      await expectConsole(page);
      const stream = await openStream(demo.origin, await apiLogin(demo.origin, demo.token));
      await stream.firstChange;

      const result = await demo.send(kind);
      expect(result.exitCode).toBe(0);
      expect(result.exitAfterMs).not.toBeNull();
      expect(result.exitAfterMs!).toBeLessThan(5_000);
      expect(result.stdout).toContain('Admin demo stopped.');
      expect(result.stderr.join('\n')).not.toMatch(/deadline exceeded|shutdown failed/i);

      const ended = await Promise.race([stream.ended, new Promise<null>(resolve => setTimeout(() => resolve(null), 5_000))]);
      expect(ended, 'the stream client saw the stream end').not.toBeNull();
      expect(ended!.how).toBe('end');
      expect(ended!.atMs - result.sentAtMs).toBeLessThan(5_000);

      // The open tab notices and starts reconnecting instead of showing stale "Live updates".
      await expect(page.locator('.shell-stream')).not.toHaveAttribute('data-state', 'live', { timeout: 10_000 });
      await expect(page.locator('[data-banner="reconnecting"], [data-banner="offline"]')).toBeVisible();
    } finally {
      demo?.dispose();
    }
  });
}

// Records why the checks above use a console helper: on Windows, Node's process.kill(pid, 'SIGINT') is a
// TerminateProcess, so the demo's SIGINT handler never runs and the stream is cut, not ended.
test('process.kill(pid, "SIGINT") from a Node parent is a hard kill on Windows (not a Ctrl+C)', async () => {
  const demo = await startDemo();
  try {
    const stream = await openStream(demo.origin, await apiLogin(demo.origin, demo.token));
    await stream.firstChange;
    process.kill(demo.child.pid!, 'SIGINT');
    const exit = await demo.exited;
    expect(exit.code).toBe(1);
    expect(demo.stdout()).not.toContain('Admin demo stopped.');
    expect((await stream.ended).how).toBe('aborted');
  } finally {
    await demo.kill();
  }
});
