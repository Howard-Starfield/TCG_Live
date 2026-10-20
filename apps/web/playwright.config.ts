import { defineConfig, devices } from '@playwright/test';

// Each run gets its own port and never attaches to a running bot (plan rule 7).
const port = Number(process.env.TCG_E2E_PORT ?? 4300 + Math.floor(Math.random() * 600));
const token = process.env.TCG_E2E_LOGIN_TOKEN ?? 'e2e-fixed-launch-token-0123456789abcdef';
process.env.TCG_E2E_PORT = String(port);
process.env.TCG_E2E_LOGIN_TOKEN = token;

export default defineConfig({
  testDir: 'e2e',
  fullyParallel: false,
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    channel: 'chrome',
    trace: 'retain-on-failure'
  },
  projects: [{ name: 'chrome', use: { ...devices['Desktop Chrome'], channel: 'chrome' } }],
  // TCG_E2E_NO_SERVER=1 runs server-less specs only (the Wave 0 toolchain smoke test).
  webServer: process.env.TCG_E2E_NO_SERVER === '1' ? undefined : {
    // Serves the prebuilt dist; never rebuilds inside the test-server step.
    command: 'node ../server/dist/admin/demo.js',
    url: `http://127.0.0.1:${port}/livez`,
    reuseExistingServer: false,
    timeout: 30_000,
    env: { PORT: String(port), TCG_ADMIN_LOGIN_TOKEN: token, TCG_ADMIN_DEMO_MODE: 'autoplay' }
  }
});
