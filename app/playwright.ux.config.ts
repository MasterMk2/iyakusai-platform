import { defineConfig, devices } from '@playwright/test';

const port = 5193;

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: ['ux-layout.spec.ts', 'mail-collaboration.spec.ts', 'ux-redesign.spec.ts', 'theme.spec.ts'],
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '.tmp/ux-playwright-results',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  projects: [{ name: 'edge', use: { ...devices['Desktop Edge'], channel: 'msedge' } }],
  webServer: {
    command: 'node dist/server/main.js',
    url: `http://127.0.0.1:${port}/api/health`,
    reuseExistingServer: false,
    env: { SMM_PORT: String(port), SMM_DATA_FILE: '.tmp/ux-demo.json' },
  },
});
