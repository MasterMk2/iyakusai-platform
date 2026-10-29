import { defineConfig, devices } from '@playwright/test';

// Cross-system gate: the REAL Task service (sibling discord-task-manager build, protected mode)
// and this app as the common Web entry, all on loopback with synthetic data and per-run keys.
// Requires SMM_TASK_SERVICE_DIR (a built discord-task-manager checkout). Ports 17641-17644.
export const CROSS = { task: 17641, mail: 17642, account: 17643, unavailable: 17644 } as const;

export default defineConfig({
  testDir: 'tests/cross',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  outputDir: '.tmp/playwright-cross-results',
  timeout: 60_000,
  use: {
    baseURL: `http://127.0.0.1:${CROSS.mail}`,
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `node scripts/integrated-stack.mjs --fresh --name cross --task-port ${CROSS.task} --mail-port ${CROSS.mail} --account-port ${CROSS.account} --unavailable-port ${CROSS.unavailable}`,
    url: `http://127.0.0.1:${CROSS.account}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
