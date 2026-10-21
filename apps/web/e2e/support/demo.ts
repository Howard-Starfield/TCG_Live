// Starts a private admin demo process for one spec file: the stock `apps/server/dist/admin/demo.js`, or
// the held-scenario launcher next to this file. Each demo gets its own free port and launch token and
// keeps its stdout, so specs can read the console links it prints (startup and rotate-link).
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const WEB_ROOT = path.resolve(here, '..', '..');
export const REPO_ROOT = path.resolve(WEB_ROOT, '..', '..');
export const DEMO_JS = path.join(REPO_ROOT, 'apps', 'server', 'dist', 'admin', 'demo.js');
export const SCENARIO_JS = path.join(here, 'scenario-demo.mjs');

/** A held scenario: the first `steps` steps of the real demo script, `waitMs` apart, then frozen. */
export interface Scenario {
  steps: number;
  waitMs?: number;
  durationMs?: number;
  /** Play the steps once, retire that event, then hold a fresh active event at its start. */
  retireOnce?: boolean;
  /** With retireOnce: the pause between the last step and the retirement. */
  retireGapMs?: number;
  /** Wave 3: 'interactive' pauses at each scripted admin decision until the console's command lands. */
  mode?: 'autoplay' | 'interactive';
  /** Interactive: how long a finished event waits for a correction before it releases on its own. */
  finalHoldMs?: number;
  /** Replace the final 24-hour hold with a real restart after this wait (a fresh event then starts). */
  endWaitMs?: number;
  /** 'off': the read-only console (commandsEnabled false, only dashboard.read), as in Discord mode by default. */
  commands?: 'on' | 'off';
  /** The local principal holds only these capabilities (the HTTP layer's test seam). */
  capabilities?: readonly string[];
}

/** Where an interactive scenario waits for the admin (DemoAdminRuntime.pausedAt). */
export interface DemoPause {
  step: number;
  /** What the admin must do now. */
  decision: string;
  matchId: 'M1' | 'M2' | null;
  /** 'players' while the script's players are recovering (rejoining an open seat, checking in again). */
  waitingFor: 'admin' | 'players';
  /** Only for the end-of-event hold: time until it releases on its own. */
  releasesInMs: number | null;
}

/** The scenario's runtime state, read over the IPC channel of a held scenario. */
export interface DemoState { pausedAt: DemoPause | null; step: number; playMode: 'autoplay' | 'interactive'; cycles: number }

export interface DemoOptions {
  scenario?: Scenario;
  token?: string;
  /** Spawn in a new (hidden) console of its own, so a console control event can target it alone. */
  ownConsole?: boolean;
}

export interface DemoProcess {
  readonly port: number;
  readonly origin: string;
  readonly token: string;
  readonly child: ChildProcess;
  /** `http://127.0.0.1:PORT/#login=<token>`. */
  loginUrl(token?: string): string;
  stdout(): string;
  stderr(): string;
  /** Resolves with the first match of `pattern` in stdout at or after `fromOffset`. */
  waitForStdout(pattern: RegExp, timeoutMs?: number, fromOffset?: number): Promise<RegExpExecArray>;
  /** Exit code and signal once the process has exited. */
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** Hard stop for cleanup (TerminateProcess on Windows). */
  kill(): Promise<void>;
  /** Held scenarios only: the runtime's pause state. */
  state(): Promise<DemoState>;
  /** Held scenarios only: resumeScript() (skips the awaited decision). Resolves false when not paused. */
  resumeScript(): Promise<boolean>;
  /** Held scenarios only: closes the runtime but keeps HTTP up, so commands answer 503. */
  closeRuntime(): Promise<void>;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export const newLaunchToken = (): string => randomBytes(24).toString('base64url');

export async function startDemo(options: DemoOptions = {}): Promise<DemoProcess> {
  const port = await freePort();
  const token = options.token ?? newLaunchToken();
  const env: NodeJS.ProcessEnv = { ...process.env, PORT: String(port), TCG_ADMIN_LOGIN_TOKEN: token };
  delete env.TCG_ADMIN_DEV_ORIGIN;
  // A caller shell with TCG_ADMIN_DEMO_MODE=interactive must not turn the stock or held demos interactive;
  // scenarios pass their mode explicitly (scenario-demo.mjs), and the stock demo is always autoplay here.
  delete env.TCG_ADMIN_DEMO_MODE;
  const script = options.scenario ? SCENARIO_JS : DEMO_JS;
  if (options.scenario) {
    env.TCG_E2E_SCENARIO_STEPS = String(options.scenario.steps);
    env.TCG_E2E_SCENARIO_WAIT_MS = String(options.scenario.waitMs ?? 40);
    env.TCG_E2E_SCENARIO_DURATION_MS = String(options.scenario.durationMs ?? 90_000);
    if (options.scenario.retireOnce) env.TCG_E2E_SCENARIO_RETIRE_ONCE = '1';
    if (options.scenario.retireGapMs !== undefined) env.TCG_E2E_SCENARIO_RETIRE_GAP_MS = String(options.scenario.retireGapMs);
    env.TCG_E2E_SCENARIO_MODE = options.scenario.mode ?? 'autoplay';
    if (options.scenario.endWaitMs !== undefined) env.TCG_E2E_SCENARIO_END_WAIT_MS = String(options.scenario.endWaitMs);
    if (options.scenario.finalHoldMs !== undefined) env.TCG_E2E_SCENARIO_FINAL_HOLD_MS = String(options.scenario.finalHoldMs);
    if (options.scenario.commands) env.TCG_E2E_SCENARIO_COMMANDS = options.scenario.commands;
    if (options.scenario.capabilities) env.TCG_E2E_SCENARIO_CAPABILITIES = options.scenario.capabilities.join(',');
  }
  // Held scenarios get an IPC channel for the pause controls (scenario-demo.mjs); the stock demo does not.
  const child = spawn(process.execPath, [script], {
    cwd: REPO_ROOT, env, stdio: options.scenario ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['ignore', 'pipe', 'pipe'],
    detached: options.ownConsole ?? false, windowsHide: true
  });
  let out = '';
  let err = '';
  const waiters = new Set<() => void>();
  child.stdout!.setEncoding('utf8').on('data', (chunk: string) => { out += chunk; for (const wake of [...waiters]) wake(); });
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { err += chunk; });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
    child.once('exit', (code, signal) => { for (const wake of [...waiters]) wake(); resolve({ code, signal }); });
  });
  let done = false;
  void exited.then(() => { done = true; });

  // IPC requests to the scenario: { id, op } out, { id, ok, state } back.
  let nextId = 0;
  const replies = new Map<number, (reply: { ok: boolean; state: DemoState }) => void>();
  child.on('message', (message: { id: number; ok: boolean; state: DemoState }) => {
    replies.get(message.id)?.(message);
    replies.delete(message.id);
  });
  const control = (op: 'state' | 'resume' | 'close-runtime') => new Promise<{ ok: boolean; state: DemoState }>((resolve, reject) => {
    if (!child.send || !child.connected) { reject(new Error('This demo has no control channel (use a scenario).')); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { replies.delete(id); reject(new Error(`Demo control "${op}" timed out.`)); }, 5_000);
    replies.set(id, reply => { clearTimeout(timer); resolve(reply); });
    child.send({ id, op });
  });

  const waitForStdout = (pattern: RegExp, timeoutMs = 20_000, fromOffset = 0) =>
    new Promise<RegExpExecArray>((resolve, reject) => {
      const check = () => {
        const match = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(out.slice(fromOffset));
        if (match) { finish(); resolve(match); return; }
        if (done) { finish(); reject(new Error(`Demo exited before printing ${pattern}.\nstdout:\n${out}\nstderr:\n${err}`)); }
      };
      const timer = setTimeout(() => { finish(); reject(new Error(`Timed out waiting for ${pattern}.\nstdout:\n${out}\nstderr:\n${err}`)); }, timeoutMs);
      const finish = () => { clearTimeout(timer); waiters.delete(check); };
      waiters.add(check);
      check();
    });

  const demo: DemoProcess = {
    port, token, child, exited,
    origin: `http://127.0.0.1:${port}`,
    loginUrl: (value = token) => `http://127.0.0.1:${port}/#login=${value}`,
    stdout: () => out,
    stderr: () => err,
    waitForStdout,
    async kill() {
      if (!done) child.kill();
      await exited;
    },
    state: async () => (await control('state')).state,
    resumeScript: async () => (await control('resume')).ok,
    async closeRuntime() { await control('close-runtime'); }
  };
  try {
    await waitForStdout(/Admin console: (\S+)/, 20_000);
  } catch (error) {
    await demo.kill();
    throw error;
  }
  return demo;
}
