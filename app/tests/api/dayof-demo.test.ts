import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig } from '../../src/server/config.js';
import { DAYOF_DEMO_POSTER } from '../../src/server/dayof/seed.js';
import { SESSION_COOKIE } from '../../src/server/http/app.js';
import { composeServer } from '../../src/server/runtime.js';
import { TEST_HOST } from '../helpers.js';

// The real demo composition (SMM_AUTH_MODE=demo): the festival-day board is on, with a synthetic period that includes
// today, so the home panel can be tried at once. Its file lives in the demo's data folder.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iyakusai-dayof-demo-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

it('opens the demo with a board that is on today, a poster besides the administrator, and the seeded notices', async () => {
  const runtime = await composeServer(loadConfig({ SMM_AUTH_MODE: 'demo', SMM_DATA_FILE: join(dir, 'state.json') }));
  try {
    expect(existsSync(join(dir, 'dayof.sqlite3'))).toBe(true);
    const res = await runtime.app.inject({ method: 'GET', url: '/api/dayof/board', headers: { host: TEST_HOST, cookie: `${SESSION_COOKIE}=${DAYOF_DEMO_POSTER}` } });
    expect(res.statusCode, res.body).toBe(200);
    const board = res.json();
    expect(board).toMatchObject({ active: true, canPost: true, day: { index: 1, total: 2 } });
    expect(board.rules).toContain('合成データ');
    expect(board.posts[0]).toMatchObject({ priority: 'urgent', status: 'open' });
    expect(board.decisions.some((d: { venueLabel: string }) => d.venueLabel === '当日本部')).toBe(true);
  } finally {
    await runtime.app.close();
  }
}, 30_000);
