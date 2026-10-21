// E2E helper: runs the real admin demo (apps/server/dist/admin/demo.js) with a compressed, held scenario.
//
// The stock demo plays a ~3-minute script on a loop, so a given canvas state can be minutes away. This
// launcher replays the first TCG_E2E_SCENARIO_STEPS steps of the real demoScript() with every wait
// shortened to TCG_E2E_SCENARIO_WAIT_MS, then holds that state (no restart) so specs can assert on it.
// With TCG_E2E_SCENARIO_RETIRE_ONCE=1 it plays the steps, retires that event, and holds a fresh one.
// Everything else is the production code path: runAdminDemo(), the real domain transition() and the
// real HTTP layer. Same environment as demo.js: PORT and TCG_ADMIN_LOGIN_TOKEN.
//
// Wave 3 additions (all through options runAdminDemo() already takes; no server code is changed):
// - TCG_E2E_SCENARIO_MODE=interactive: the runtime's interactive play mode. The scenario pauses at each
//   scripted admin decision until the console's command lands (DemoAdminRuntime.pausedAt).
// - TCG_E2E_SCENARIO_END_WAIT_MS: replaces the final 24-hour hold with a real restart after this wait, so an
//   interactive event that pauses for a correction retires and a fresh event starts once it is answered.
// - TCG_E2E_SCENARIO_FINAL_HOLD_MS: the runtime's finalHoldMs (how long a finished interactive event waits
//   for a correction before it releases on its own; DEMO_FINAL_HOLD_MS = 60 s by default).
// - TCG_E2E_SCENARIO_COMMANDS=off: the read-only fixture. The HTTP layer is built with commandsEnabled false
//   (Discord mode without TCG_ADMIN_COMMANDS=1, decision 4); the runtime itself is unchanged.
// - TCG_E2E_SCENARIO_CAPABILITIES=a,b: the local principal holds only these capabilities (the HTTP layer's
//   own test seam), for the "capability missing" 403.
// - An IPC control channel when spawned with one (support/demo.ts): { id, op } messages, answered with
//   { id, ok, state } where state is { pausedAt, step, playMode, cycles }. Ops: 'state', 'resume'
//   (resumeScript()), 'close-runtime' (closes the runtime but keeps HTTP up, so commands get 503).
import { runAdminDemo } from '../../../server/dist/admin/demo.js';
import { createAdminHttp } from '../../../server/dist/admin/http/handler.js';
import { demoScript } from '../../../server/dist/admin/runtime/demo-runtime.js';

const full = demoScript();
const steps = Number(process.env.TCG_E2E_SCENARIO_STEPS ?? full.length - 1);
const waitMs = Number(process.env.TCG_E2E_SCENARIO_WAIT_MS ?? 40);
const durationMs = Number(process.env.TCG_E2E_SCENARIO_DURATION_MS ?? 90_000);
const HOLD_MS = 24 * 60 * 60_000;

const retireOnce = process.env.TCG_E2E_SCENARIO_RETIRE_ONCE === '1';
const retireGapMs = Number(process.env.TCG_E2E_SCENARIO_RETIRE_GAP_MS ?? waitMs);
const mode = process.env.TCG_E2E_SCENARIO_MODE === 'interactive' ? 'interactive' : 'autoplay';
const endWaitMs = process.env.TCG_E2E_SCENARIO_END_WAIT_MS ? Number(process.env.TCG_E2E_SCENARIO_END_WAIT_MS) : HOLD_MS;
const finalHoldMs = process.env.TCG_E2E_SCENARIO_FINAL_HOLD_MS ? Number(process.env.TCG_E2E_SCENARIO_FINAL_HOLD_MS) : undefined;
const commandsOff = process.env.TCG_E2E_SCENARIO_COMMANDS === 'off';
const capabilities = process.env.TCG_E2E_SCENARIO_CAPABILITIES?.split(',').map(item => item.trim()).filter(Boolean);

const script = full.filter(step => !('restart' in step)).slice(0, steps)
  .map(step => ({ ...step, wait: Math.min(step.wait, waitMs) }));
if (retireOnce && script.length > 0) {
  // Play the steps once, retire that event, then hold the fresh event before its first step: the
  // runtime replays the script from the top after a restart, so the first wait is long from then on.
  let reads = 0;
  const first = script[0];
  const shortWait = first.wait;
  Object.defineProperty(first, 'wait', { get: () => (reads++ === 0 ? shortWait : HOLD_MS) });
  script.push({ wait: retireGapMs, restart: true });
} else {
  script.push({ wait: endWaitMs, restart: true });
}

const createHandler = commandsOff || capabilities
  ? options => createAdminHttp({ ...options, commandsEnabled: commandsOff ? false : options.commandsEnabled },
    capabilities ? { capabilities } : {})
  : undefined;

const demo = await runAdminDemo({ runtime: { script, durationMs, mode, ...(finalHoldMs === undefined ? {} : { finalHoldMs }) }, createHandler });
process.stdout.write(`E2E scenario: ${script.length - 1} steps, ${waitMs} ms apart, ${durationMs} ms matches, ${mode}` +
  `${commandsOff ? ', commands off' : ''}${capabilities ? `, capabilities ${capabilities.join('+')}` : ''}\n`);

const state = () => ({ pausedAt: demo.runtime.pausedAt, step: demo.runtime.step, playMode: demo.runtime.playMode, cycles: demo.runtime.cycles });

if (process.send) {
  // The channel must not keep the process alive on its own; the HTTP server does that until shutdown.
  process.channel?.unref();
  process.on('message', message => {
    const { id, op } = message ?? {};
    let ok = true;
    if (op === 'resume') ok = demo.runtime.resumeScript();
    else if (op === 'close-runtime') void demo.runtime.close();
    else if (op !== 'state') ok = false;
    process.send?.({ id, ok, state: state() });
  });
  // The spec runner went away without stopping us: do not linger as an orphan.
  process.once('disconnect', () => shutdown());
}

let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  void demo.stop().then(() => { process.stdout.write('Admin demo stopped.\n'); });
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGBREAK', shutdown);
