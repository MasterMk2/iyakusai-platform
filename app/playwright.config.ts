import { defineConfig, devices } from '@playwright/test';

const port = 5179;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '.tmp/playwright-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'node dist/server/main.js',
      url: `http://127.0.0.1:${port}/api/health`,
      reuseExistingServer: false,
      env: {
        SMM_PORT: String(port),
        SMM_DATA_FILE: '.tmp/e2e/demo-state.json',
      },
    },
    {
      // Account login, labelled loopback MOCK composition (synthetic providers and mock DM), port 5182.
      command: 'node dist/server/main.js',
      url: 'http://127.0.0.1:5182/api/health',
      reuseExistingServer: false,
      env: {
        SMM_AUTH_MODE: 'account-mock',
        SMM_PORT: '5182',
        SMM_DATA_FILE: '.tmp/e2e-account/state.json',
      },
    },
    {
      // Test-only synthetic proxy in front of a trusted-proxy-mode server (ports 5180/5181, loopback only).
      command: 'node tests/e2e/proxy-harness.mjs',
      url: 'http://127.0.0.1:5181/api/health',
      reuseExistingServer: false,
    },
  ],
});
