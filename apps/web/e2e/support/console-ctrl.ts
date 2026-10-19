// Starts the stock demo inside a private hidden console (console-ctrl.ps1) so a spec can send it a real
// Ctrl+C or Ctrl+Break, the way a terminal does. Windows only.
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { DEMO_JS, freePort, newLaunchToken, REPO_ROOT } from './demo';
import { rawRequest } from './http';

const HELPER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'console-ctrl.ps1');

export interface ConsoleDemo {
  port: number;
  origin: string;
  token: string;
  pid: number;
  /** Sends the event; resolves with the exit code and the time from the event to the exit, plus the demo's output. */
  send(kind: 'ctrl-c' | 'ctrl-break'): Promise<{ sentAtMs: number; exitCode: number | 'timeout'; exitAfterMs: number | null; stdout: string[]; stderr: string[] }>;
  /** Hard stop for cleanup. */
  dispose(): void;
}

export async function startDemoInConsole(): Promise<ConsoleDemo> {
  const port = await freePort();
  const token = newLaunchToken();
  const helper = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Exe', process.execPath, '-Script', DEMO_JS],
    { cwd: REPO_ROOT, env: { ...process.env, PORT: String(port), TCG_ADMIN_LOGIN_TOKEN: token }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines: string[] = [];
  let helperErr = '';
  const wakers = new Set<() => void>();
  readline.createInterface({ input: helper.stdout! }).on('line', line => { lines.push(line); for (const wake of [...wakers]) wake(); });
  helper.stderr!.setEncoding('utf8').on('data', (chunk: string) => { helperErr += chunk; });
  let helperDone = false;
  const helperExit = new Promise<void>(resolve => helper.once('exit', () => { helperDone = true; for (const wake of [...wakers]) wake(); resolve(); }));

  const waitLine = (pattern: RegExp, timeoutMs: number) => new Promise<string>((resolve, reject) => {
    const check = () => {
      const line = lines.find(item => pattern.test(item));
      if (line) { finish(); resolve(line); }
      else if (helperDone) { finish(); reject(new Error(`console helper exited before ${pattern}:\n${lines.join('\n')}\n${helperErr}`)); }
    };
    const timer = setTimeout(() => { finish(); reject(new Error(`timed out waiting for ${pattern}:\n${lines.join('\n')}\n${helperErr}`)); }, timeoutMs);
    const finish = () => { clearTimeout(timer); wakers.delete(check); };
    wakers.add(check);
    check();
  });

  const pid = Number((await waitLine(/^pid:\d+$/, 30_000)).slice(4));
  const origin = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      if ((await rawRequest(origin, 'GET', '/livez')).status === 200) break;
    } catch { /* not listening yet */ }
    if (Date.now() > deadline) throw new Error(`demo did not start:\n${lines.join('\n')}\n${helperErr}`);
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  return {
    port, origin, token, pid,
    async send(kind) {
      helper.stdin!.write(`${kind}\n`);
      const sentAtMs = Number((await waitLine(/^sent:\d+$/, 10_000)).slice(5));
      const exit = await waitLine(/^exit:/, 20_000);
      await helperExit;
      const [, code, at] = exit.split(':');
      return {
        sentAtMs,
        exitCode: code === 'timeout' ? 'timeout' : Number(code),
        exitAfterMs: at ? Number(at) - sentAtMs : null,
        stdout: lines.filter(line => line.startsWith('out:')).map(line => line.slice(4)),
        stderr: lines.filter(line => line.startsWith('err:')).map(line => line.slice(4))
      };
    },
    dispose() {
      if (!helperDone) {
        try { process.kill(pid); } catch { /* already gone */ }
        helper.kill();
      }
    }
  };
}
