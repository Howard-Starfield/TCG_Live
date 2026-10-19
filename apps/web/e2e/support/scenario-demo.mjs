// E2E helper: runs the real admin demo (apps/server/dist/admin/demo.js) with a compressed, held scenario.
//
// The stock demo plays a ~3-minute script on a loop, so a given canvas state can be minutes away. This
// launcher replays the first TCG_E2E_SCENARIO_STEPS steps of the real demoScript() with every wait
// shortened to TCG_E2E_SCENARIO_WAIT_MS, then holds that state (no restart) so specs can assert on it.
// With TCG_E2E_SCENARIO_RETIRE_ONCE=1 it plays the steps, retires that event, and holds a fresh one.
// Everything else is the production code path: runAdminDemo(), the real domain transition() and the
// real HTTP layer. Same environment as demo.js: PORT and TCG_ADMIN_LOGIN_TOKEN.
import { runAdminDemo } from '../../../server/dist/admin/demo.js';
import { demoScript } from '../../../server/dist/admin/runtime/demo-runtime.js';

const full = demoScript();
const steps = Number(process.env.TCG_E2E_SCENARIO_STEPS ?? full.length - 1);
const waitMs = Number(process.env.TCG_E2E_SCENARIO_WAIT_MS ?? 40);
const durationMs = Number(process.env.TCG_E2E_SCENARIO_DURATION_MS ?? 90_000);
const HOLD_MS = 24 * 60 * 60_000;

const retireOnce = process.env.TCG_E2E_SCENARIO_RETIRE_ONCE === '1';
const retireGapMs = Number(process.env.TCG_E2E_SCENARIO_RETIRE_GAP_MS ?? waitMs);

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
  script.push({ wait: HOLD_MS, restart: true });
}

const demo = await runAdminDemo({ runtime: { script, durationMs } });
process.stdout.write(`E2E scenario: ${script.length - 1} steps, ${waitMs} ms apart, ${durationMs} ms matches\n`);

let stopping = false;
const shutdown = () => {
  if (stopping) return;
  stopping = true;
  void demo.stop().then(() => { process.stdout.write('Admin demo stopped.\n'); });
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
process.once('SIGBREAK', shutdown);
