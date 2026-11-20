import { readFileSync, statfsSync, statSync } from 'node:fs';
import os from 'node:os';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  levelOf,
  SYSTEM_DISK_RESERVE_BYTES,
  SYSTEM_THRESHOLDS,
  type SystemDisk,
  type SystemLevel,
  type SystemStatusResponse,
} from '../../shared/system.js';
import { DomainError, type User } from '../domain/types.js';

// 設定 › サーバーの状態 (2026-11-21): GET /api/system/status for access administrators. Every reading is taken when
// asked; nothing runs in the background. The CPU's busy share is the difference of two readings of the cores' times:
// the one kept from the last request when it is recent, or two taken half a second apart.

/** Milliseconds the cores spent idle and in total since the machine started, summed over the cores. */
export interface CpuTimes {
  idle: number;
  total: number;
}

/** What the readings come from: the machine's (realProbe), or a stand-in in the tests. Null: not known here. */
export interface SystemProbe {
  cpuTimes(): CpuTimes | null;
  cores(): number;
  loadavg(): [number, number, number] | null;
  memory(): { totalBytes: number; availableBytes: number } | null;
  container(): { usedBytes: number; limitBytes: number | null } | null;
  uptimeSeconds(): number | null;
  /** The disk holding `path`: an id that is the same for two paths on one disk, and its sizes. */
  disk(path: string): { device: string; totalBytes: number; freeBytes: number; usedBytes: number } | null;
  rssBytes(): number;
}

export interface SystemStatusOptions {
  /** What is kept on which paths. Paths on one disk are shown once, their labels joined. */
  disks: { label: string; paths: string[] }[];
  probe?: SystemProbe;
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /** When the app started (ms). Default: when the process started. */
  startedAt?: number;
}

const MIN_WINDOW_MS = 500;
const MAX_WINDOW_MS = 120_000;
const RANKS: Record<SystemLevel, number> = { ok: 0, warn: 1, alert: 2 };

export function worst(levels: SystemLevel[]): SystemLevel {
  return levels.reduce<SystemLevel>((a, b) => (RANKS[b] > RANKS[a] ? b : a), 'ok');
}

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;
const clampPercent = (n: number) => round1(Math.min(100, Math.max(0, n)));

export class SystemStatus {
  private readonly probe: SystemProbe;
  private readonly now: () => number;
  private readonly wait: (ms: number) => Promise<void>;
  private readonly startedAt: number;
  private last: { at: number; times: CpuTimes } | null = null;

  constructor(private readonly options: SystemStatusOptions) {
    this.probe = options.probe ?? realProbe();
    this.now = options.now ?? Date.now;
    this.wait = options.wait ?? ((ms) => new Promise((done) => setTimeout(done, ms)));
    this.startedAt = options.startedAt ?? Date.now() - process.uptime() * 1000;
  }

  async read(): Promise<SystemStatusResponse> {
    const cores = Math.max(1, this.probe.cores());
    const busy = await this.cpu();
    const cpuLevel = levelOf(busy?.percent ?? null, SYSTEM_THRESHOLDS.cpu);

    const avg = this.probe.loadavg();
    const load = avg
      ? { one: round2(avg[0]), five: round2(avg[1]), fifteen: round2(avg[2]), perCore: round2(avg[0] / cores) }
      : null;
    const loadLevel = load ? levelOf(load.perCore, SYSTEM_THRESHOLDS.loadPerCore) : 'ok';

    const mem = this.probe.memory();
    const memory =
      mem && mem.totalBytes > 0
        ? (() => {
            const usedPercent = clampPercent(100 * (1 - mem.availableBytes / mem.totalBytes));
            return { totalBytes: mem.totalBytes, availableBytes: mem.availableBytes, usedPercent, level: levelOf(usedPercent, SYSTEM_THRESHOLDS.memory) };
          })()
        : null;

    const box = this.probe.container();
    const container = box
      ? (() => {
          const usedPercent = box.limitBytes && box.limitBytes > 0 ? clampPercent((100 * box.usedBytes) / box.limitBytes) : null;
          return { usedBytes: box.usedBytes, limitBytes: box.limitBytes, usedPercent, level: levelOf(usedPercent, SYSTEM_THRESHOLDS.appMemory) };
        })()
      : null;

    const disks = this.disks();
    const at = this.now();
    const levels: SystemLevel[] = [cpuLevel, loadLevel, memory?.level ?? 'ok', container?.level ?? 'ok', ...disks.map((d) => d.level)];
    return {
      sampledAt: new Date(at).toISOString(),
      cpu: { percent: busy?.percent ?? null, windowSeconds: busy?.windowSeconds ?? null, cores, level: cpuLevel },
      load: load ? { ...load, level: loadLevel } : null,
      memory,
      disks,
      uptimeSeconds: this.probe.uptimeSeconds(),
      app: {
        startedAt: new Date(this.startedAt).toISOString(),
        uptimeSeconds: Math.max(0, Math.round((at - this.startedAt) / 1000)),
        rssBytes: this.probe.rssBytes(),
        container,
      },
      level: worst(levels),
    };
  }

  /** The busy share since the last reading (kept when it is 0.5 s to 2 min old), or over a fresh half second. */
  private async cpu(): Promise<{ percent: number | null; windowSeconds: number } | null> {
    let start = this.last;
    if (!start || this.now() - start.at > MAX_WINDOW_MS) {
      const times = this.probe.cpuTimes();
      if (!times) return null;
      start = { at: this.now(), times };
    }
    const gap = MIN_WINDOW_MS - (this.now() - start.at);
    if (gap > 0) await this.wait(gap);
    const end = this.probe.cpuTimes();
    const endAt = this.now();
    if (!end) return null;
    this.last = { at: endAt, times: end };
    const total = end.total - start.times.total;
    const idle = end.idle - start.times.idle;
    const windowSeconds = round1((endAt - start.at) / 1000);
    // Times that went backwards (a core taken away, the counters reset) or did not move tell nothing.
    if (!(total > 0) || idle < 0) return { percent: null, windowSeconds };
    return { percent: clampPercent(100 * (1 - idle / total)), windowSeconds };
  }

  private disks(): SystemDisk[] {
    const byDevice = new Map<string, { labels: string[]; totalBytes: number; freeBytes: number; usedBytes: number }>();
    for (const group of this.options.disks) {
      for (const path of group.paths) {
        const disk = this.probe.disk(path);
        if (!disk || disk.totalBytes <= 0) continue;
        const known = byDevice.get(disk.device);
        if (known) {
          if (!known.labels.includes(group.label)) known.labels.push(group.label);
        } else {
          byDevice.set(disk.device, { labels: [group.label], totalBytes: disk.totalBytes, freeBytes: disk.freeBytes, usedBytes: disk.usedBytes });
        }
      }
    }
    return [...byDevice.values()].map((d) => {
      // As df counts it: the space reserved for the system is neither used nor free for the app.
      const usedPercent = clampPercent((100 * d.usedBytes) / Math.max(1, d.usedBytes + d.freeBytes));
      const level = worst([levelOf(usedPercent, SYSTEM_THRESHOLDS.disk), d.freeBytes < SYSTEM_DISK_RESERVE_BYTES ? 'alert' : 'ok']);
      return { label: d.labels.join('・'), totalBytes: d.totalBytes, freeBytes: d.freeBytes, usedPercent, level };
    });
  }
}

function readNumber(file: string): number | null {
  try {
    const text = readFileSync(file, 'utf8').trim();
    if (!/^\d+$/.test(text)) return null;
    return Number(text);
  } catch {
    return null;
  }
}

function readStat(file: string, key: string): number {
  try {
    const line = readFileSync(file, 'utf8')
      .split('\n')
      .find((l) => l.startsWith(`${key} `));
    const value = line ? Number(line.slice(key.length + 1).trim()) : 0;
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

/** /proc/meminfo's MemAvailable (what can be used without swapping), or the OS's free memory elsewhere. */
function memoryOfMachine(): { totalBytes: number; availableBytes: number } | null {
  if (process.platform === 'linux') {
    try {
      const info = readFileSync('/proc/meminfo', 'utf8');
      const kib = (key: string) => {
        const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(info);
        return m ? Number(m[1]) * 1024 : null;
      };
      const total = kib('MemTotal');
      const available = kib('MemAvailable');
      if (total && available !== null) return { totalBytes: total, availableBytes: available };
    } catch {
      // fall back to the OS's numbers
    }
  }
  const total = os.totalmem();
  return total > 0 ? { totalBytes: total, availableBytes: os.freemem() } : null;
}

/**
 * The container's memory as `docker stats` counts it (use less the file cache it can drop), from cgroup v2 or v1.
 * Null outside a container, or where the cgroup files cannot be read.
 */
function memoryOfContainer(): { usedBytes: number; limitBytes: number | null } | null {
  if (process.platform !== 'linux') return null;
  const v2 = readNumber('/sys/fs/cgroup/memory.current');
  if (v2 !== null) {
    // "max" (no limit) or a missing file: no limit to compare with.
    const limit = readNumber('/sys/fs/cgroup/memory.max');
    const cache = readStat('/sys/fs/cgroup/memory.stat', 'inactive_file');
    return { usedBytes: Math.max(0, v2 - cache), limitBytes: limit };
  }
  const v1 = readNumber('/sys/fs/cgroup/memory/memory.usage_in_bytes');
  if (v1 !== null) {
    const raw = readNumber('/sys/fs/cgroup/memory/memory.limit_in_bytes');
    // v1 writes a number near 2^63 for "no limit".
    const limit = raw !== null && raw < 2 ** 60 ? raw : null;
    const cache = readStat('/sys/fs/cgroup/memory/memory.stat', 'total_inactive_file');
    return { usedBytes: Math.max(0, v1 - cache), limitBytes: limit };
  }
  return null;
}

/** The machine's readings through Node and, on Linux, /proc and the cgroup files. */
export function realProbe(): SystemProbe {
  return {
    cpuTimes() {
      const cpus = os.cpus();
      if (cpus.length === 0) return null;
      let idle = 0;
      let total = 0;
      for (const { times } of cpus) {
        idle += times.idle;
        total += times.user + times.nice + times.sys + times.idle + times.irq;
      }
      return { idle, total };
    },
    cores: () => os.cpus().length || os.availableParallelism(),
    // Windows answers zeros: it has no load average.
    loadavg: () => (process.platform === 'win32' ? null : (os.loadavg() as [number, number, number])),
    memory: memoryOfMachine,
    container: memoryOfContainer,
    uptimeSeconds: () => {
      const s = os.uptime();
      return Number.isFinite(s) && s > 0 ? Math.round(s) : null;
    },
    disk(path) {
      try {
        const device = String(statSync(path).dev);
        const fs = statfsSync(path);
        return { device, totalBytes: fs.blocks * fs.bsize, freeBytes: fs.bavail * fs.bsize, usedBytes: (fs.blocks - fs.bfree) * fs.bsize };
      } catch {
        return null;
      }
    },
    rssBytes: () => process.memoryUsage.rss(),
  };
}

export function registerSystemStatusRoutes(app: FastifyInstance, status: SystemStatus, deps: { requireUser: (request: FastifyRequest) => User }) {
  app.get('/api/system/status', async (request): Promise<SystemStatusResponse> => {
    const user = deps.requireUser(request);
    if (user.disabled || !user.canManageAccess) throw new DomainError('forbidden', 'サーバーの状態は権限管理者だけが見られます。');
    return status.read();
  });
}
