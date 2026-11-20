import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { realProbe, SystemStatus, worst, type CpuTimes, type SystemProbe } from '../../src/server/ops/system-status.js';
import { levelOf, SYSTEM_DISK_RESERVE_BYTES } from '../../src/shared/system.js';

// 設定 › サーバーの状態: the readings from a stand-in machine (no real CPU, memory or disk is relied on).

const GiB = 1024 ** 3;

class FakeMachine implements SystemProbe {
  times: CpuTimes[] = [];
  memoryNow: { totalBytes: number; availableBytes: number } | null = { totalBytes: 8 * GiB, availableBytes: 6 * GiB };
  box: { usedBytes: number; limitBytes: number | null } | null = { usedBytes: 256 * 1024 ** 2, limitBytes: GiB };
  load: [number, number, number] | null = [0.5, 0.4, 0.3];
  disks = new Map<string, { device: string; totalBytes: number; freeBytes: number; usedBytes: number }>();
  cpuTimes() {
    return this.times.shift() ?? null;
  }
  cores() {
    return 4;
  }
  loadavg() {
    return this.load;
  }
  memory() {
    return this.memoryNow;
  }
  container() {
    return this.box;
  }
  uptimeSeconds() {
    return 3 * 86400 + 4 * 3600;
  }
  disk(path: string) {
    return this.disks.get(path) ?? null;
  }
  rssBytes() {
    return 180 * 1024 ** 2;
  }
}

function setup(disks: { label: string; paths: string[] }[] = [{ label: 'データ', paths: ['/data'] }]) {
  const machine = new FakeMachine();
  machine.disks.set('/data', { device: 'a', totalBytes: 800 * GiB, freeBytes: 700 * GiB, usedBytes: 60 * GiB });
  const clock = { now: Date.parse('2026-11-21T03:00:00Z') };
  const waits: number[] = [];
  const status = new SystemStatus({
    disks,
    probe: machine,
    now: () => clock.now,
    wait: async (ms) => {
      waits.push(ms);
      clock.now += ms;
    },
    startedAt: clock.now - 2 * 3600 * 1000,
  });
  return { machine, clock, waits, status };
}

describe('the CPU busy share', () => {
  it('takes two readings half a second apart the first time, then uses the last one', async () => {
    const { machine, clock, waits, status } = setup();
    machine.times.push({ idle: 1000, total: 2000 }, { idle: 1100, total: 2400 });
    const first = await status.read();
    expect(waits).toEqual([500]);
    expect(first.cpu).toMatchObject({ percent: 75, windowSeconds: 0.5, cores: 4, level: 'ok' });

    clock.now += 10_000;
    machine.times.push({ idle: 1100 + 2000, total: 2400 + 40_000 });
    const second = await status.read();
    expect(waits).toEqual([500]);
    expect(second.cpu).toMatchObject({ percent: 95, windowSeconds: 10, level: 'alert' });
    expect(second.level).toBe('alert');
  });

  it('starts again when the last reading is more than two minutes old', async () => {
    const { machine, clock, waits, status } = setup();
    machine.times.push({ idle: 0, total: 0 }, { idle: 50, total: 100 });
    await status.read();
    clock.now += 5 * 60_000;
    machine.times.push({ idle: 10_000, total: 20_000 }, { idle: 10_090, total: 20_100 });
    const later = await status.read();
    expect(waits).toEqual([500, 500]);
    expect(later.cpu.percent).toBe(10);
  });

  it('says nothing when the times cannot be read or did not move', async () => {
    const { machine, status } = setup();
    expect((await status.read()).cpu).toMatchObject({ percent: null, windowSeconds: null, level: 'ok' });
    machine.times.push({ idle: 10, total: 20 }, { idle: 10, total: 20 });
    expect((await status.read()).cpu.percent).toBeNull();
  });
});

describe('memory, disks and the app', () => {
  it('reports the used share of memory and the container against its limit', async () => {
    const { machine, status } = setup();
    machine.memoryNow = { totalBytes: 8 * GiB, availableBytes: 0.8 * GiB };
    const s = await status.read();
    expect(s.memory).toEqual({ totalBytes: 8 * GiB, availableBytes: 0.8 * GiB, usedPercent: 90, level: 'warn' });
    expect(s.app.container).toEqual({ usedBytes: 256 * 1024 ** 2, limitBytes: GiB, usedPercent: 25, level: 'ok' });
    expect(s.app).toMatchObject({ uptimeSeconds: 2 * 3600, rssBytes: 180 * 1024 ** 2, startedAt: '2026-11-21T01:00:00.000Z' });
    expect(s.uptimeSeconds).toBe(3 * 86400 + 4 * 3600);
    expect(s.level).toBe('warn');
  });

  it('has no percent for a container without a limit, and nothing where the machine cannot tell', async () => {
    const { machine, status } = setup();
    machine.box = { usedBytes: 300 * 1024 ** 2, limitBytes: null };
    machine.load = null;
    machine.memoryNow = null;
    const s = await status.read();
    expect(s.app.container).toEqual({ usedBytes: 300 * 1024 ** 2, limitBytes: null, usedPercent: null, level: 'ok' });
    expect(s.load).toBeNull();
    expect(s.memory).toBeNull();
  });

  it('shows two folders on one disk once, with both labels, and leaves out one that does not exist', async () => {
    const { machine, status } = setup([
      { label: 'データ', paths: ['/data', '/data/mailbox', '/nowhere'] },
      { label: 'バックアップ', paths: ['/backups'] },
    ]);
    machine.disks.set('/data/mailbox', { device: 'a', totalBytes: 800 * GiB, freeBytes: 700 * GiB, usedBytes: 60 * GiB });
    machine.disks.set('/backups', { device: 'a', totalBytes: 800 * GiB, freeBytes: 700 * GiB, usedBytes: 60 * GiB });
    const s = await status.read();
    expect(s.disks).toEqual([{ label: 'データ・バックアップ', totalBytes: 800 * GiB, freeBytes: 700 * GiB, usedPercent: 7.9, level: 'ok' }]);
  });

  it('alerts on a disk with less free space than the minutes need, whatever its percent', async () => {
    const { machine, status } = setup([
      { label: 'データ', paths: ['/data'] },
      { label: 'バックアップ', paths: ['/backups'] },
    ]);
    machine.disks.set('/backups', { device: 'b', totalBytes: 8 * GiB, freeBytes: SYSTEM_DISK_RESERVE_BYTES - 1, usedBytes: 3 * GiB });
    const s = await status.read();
    expect(s.disks.map((d) => [d.label, d.level])).toEqual([
      ['データ', 'ok'],
      ['バックアップ', 'alert'],
    ]);
    expect(s.level).toBe('alert');
  });

  it('warns on load only per core, and never alerts on load alone', async () => {
    const { machine, status } = setup();
    machine.load = [12, 8, 4];
    const s = await status.read();
    expect(s.load).toEqual({ one: 12, five: 8, fifteen: 4, perCore: 3, level: 'warn' });
    expect(s.level).toBe('warn');
  });

  it('sends no name, address, path or environment of the machine', async () => {
    const { machine, status } = setup();
    machine.times.push({ idle: 0, total: 0 }, { idle: 1, total: 2 });
    const keys = new Set<string>();
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          keys.add(k);
          walk(x);
        }
      }
    };
    const s = await status.read();
    walk(s);
    expect([...keys].sort()).toEqual(
      ['app', 'availableBytes', 'container', 'cores', 'cpu', 'disks', 'fifteen', 'five', 'freeBytes', 'label', 'level', 'limitBytes', 'load', 'memory', 'one', 'percent', 'perCore', 'rssBytes', 'sampledAt', 'startedAt', 'totalBytes', 'uptimeSeconds', 'usedBytes', 'usedPercent', 'windowSeconds'].sort(),
    );
    expect(JSON.stringify(s)).not.toContain('/data');
  });
});

describe('levels', () => {
  it('turns warn and alert at the thresholds', () => {
    expect(levelOf(79.9, { warn: 80, alert: 95 })).toBe('ok');
    expect(levelOf(80, { warn: 80, alert: 95 })).toBe('warn');
    expect(levelOf(95, { warn: 80, alert: 95 })).toBe('alert');
    expect(levelOf(5, { warn: 1.5 })).toBe('warn');
    expect(levelOf(null, { warn: 1 })).toBe('ok');
    expect(worst(['ok', 'alert', 'warn'])).toBe('alert');
    expect(worst([])).toBe('ok');
  });
});

describe('the real machine', () => {
  it('reads cores, the process memory and the disk of a folder that exists', () => {
    const probe = realProbe();
    expect(probe.cores()).toBeGreaterThanOrEqual(1);
    expect(probe.rssBytes()).toBeGreaterThan(0);
    const disk = probe.disk(tmpdir());
    expect(disk?.totalBytes).toBeGreaterThan(0);
    expect(probe.disk('/surely/not/a/folder/here')).toBeNull();
  });

  // The server runs Linux (in a container): /proc and the load average are read there, and CI runs this on Linux.
  it.runIf(process.platform === 'linux')('reads /proc and the load average on Linux', async () => {
    const probe = realProbe();
    const memory = probe.memory();
    expect(memory?.totalBytes).toBeGreaterThan(0);
    expect(memory!.availableBytes).toBeGreaterThan(0);
    expect(memory!.availableBytes).toBeLessThanOrEqual(memory!.totalBytes);
    expect(probe.loadavg()).toHaveLength(3);
    expect(probe.cpuTimes()?.total).toBeGreaterThan(0);
    expect(probe.uptimeSeconds()).toBeGreaterThan(0);
    const status = await new SystemStatus({ disks: [{ label: 'データ', paths: [tmpdir()] }] }).read();
    expect(status.cpu.percent).not.toBeNull();
    expect(status.memory?.usedPercent).toBeGreaterThanOrEqual(0);
    expect(status.disks).toHaveLength(1);
  });
});
