import type { FastifyInstance } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';
import { SystemStatus, type SystemProbe } from '../../src/server/ops/system-status.js';
import { StateStore } from '../../src/server/domain/store.js';
import { buildApp, SESSION_COOKIE } from '../../src/server/http/app.js';
import { seedState, TEST_HOST, TEST_PORT } from '../helpers.js';

// GET /api/system/status in the demo composition (persona cookie): access administrators only, with a stand-in machine.

const GiB = 1024 ** 3;
const probe: SystemProbe = {
  cpuTimes: () => ({ idle: 100, total: 200 }),
  cores: () => 2,
  loadavg: () => [0.2, 0.1, 0.05],
  memory: () => ({ totalBytes: 4 * GiB, availableBytes: 3 * GiB }),
  container: () => ({ usedBytes: GiB / 4, limitBytes: GiB }),
  uptimeSeconds: () => 3600,
  disk: (path) => (path === '/data' ? { device: 'a', totalBytes: 100 * GiB, freeBytes: 80 * GiB, usedBytes: 20 * GiB } : null),
  rssBytes: () => 100 * 1024 ** 2,
};

let app: FastifyInstance;
afterEach(async () => {
  await app?.close();
});

async function build(on = true) {
  app = await buildApp({
    store: new StateStore(await seedState(), null),
    listenPort: TEST_PORT,
    systemStatus: on ? new SystemStatus({ probe, disks: [{ label: 'データ', paths: ['/data'] }], wait: async () => undefined }) : null,
  });
}

async function get(userId: string | null) {
  const res = await app.inject({ method: 'GET', url: '/api/system/status', headers: { host: TEST_HOST, ...(userId ? { cookie: `${SESSION_COOKIE}=${userId}` } : {}) } });
  return { status: res.statusCode, json: res.json() as Record<string, unknown> };
}

describe('GET /api/system/status', () => {
  it('answers an access administrator with the readings', async () => {
    await build();
    const res = await get('u-admin');
    expect(res.status).toBe(200);
    expect(res.json).toMatchObject({
      cpu: { cores: 2, level: 'ok' },
      load: { one: 0.2, perCore: 0.1, level: 'ok' },
      memory: { usedPercent: 25, level: 'ok' },
      disks: [{ label: 'データ', usedPercent: 20, level: 'ok' }],
      uptimeSeconds: 3600,
      app: { rssBytes: 100 * 1024 ** 2, container: { usedPercent: 25 } },
      level: 'ok',
    });
  });

  it('refuses a member without the grant and someone not signed in', async () => {
    await build();
    expect((await get('u-editor-a')).status).toBe(403);
    expect((await get(null)).status).toBe(401);
  });

  it('does not exist on a server without it', async () => {
    await build(false);
    expect((await get('u-admin')).status).toBe(404);
  });
});
