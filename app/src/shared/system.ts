// The server's state for access administrators (2026-11-21, 設定 › サーバーの状態): how busy the machine the app runs
// on is (CPU, load, memory, disk), and the app's own memory and time since it started. The app runs in a container, so
// the CPU, load, memory and uptime are the whole machine's (a container sees the host's /proc), and "app" is the
// container's own share. No host name, address, kernel, provider, path, environment or process list is sent.

/** ok: nothing to do. warn: worth a look (§4 注意, yellow). alert: act now (§4 すぐ対応, red). */
export type SystemLevel = 'ok' | 'warn' | 'alert';

export const SYSTEM_LEVEL_LABELS: Record<SystemLevel, string> = { ok: '問題なし', warn: '注意', alert: 'すぐ対応' };

/** Percent used at which a reading turns warn / alert. */
export const SYSTEM_THRESHOLDS = {
  cpu: { warn: 80, alert: 95 },
  memory: { warn: 85, alert: 95 },
  appMemory: { warn: 85, alert: 95 },
  disk: { warn: 85, alert: 95 },
  /** The 1-minute load average per core. Load counts tasks waiting for the disk too, so it never alerts alone. */
  loadPerCore: { warn: 1.5 },
} as const;

/**
 * Below this much free space the minutes refuse new recordings (minutes/routes.ts DISK_RESERVE_BYTES): a disk with
 * less is alert whatever its percent.
 */
export const SYSTEM_DISK_RESERVE_BYTES = 5 * 1024 * 1024 * 1024;

/** How often the open panel asks again. */
export const SYSTEM_REFRESH_SECONDS = 10;

export function levelOf(percent: number | null, limits: { warn: number; alert?: number }): SystemLevel {
  if (percent === null || !Number.isFinite(percent)) return 'ok';
  if (limits.alert !== undefined && percent >= limits.alert) return 'alert';
  return percent >= limits.warn ? 'warn' : 'ok';
}

export interface SystemDisk {
  /** What is kept there (データ, バックアップ, or both when they share one disk). Never a path. */
  label: string;
  totalBytes: number;
  freeBytes: number;
  usedPercent: number;
  level: SystemLevel;
}

/** GET /api/system/status (access administrators). Each part is null when this machine cannot tell it. */
export interface SystemStatusResponse {
  sampledAt: string;
  cpu: {
    /** Busy share of all cores over the last `windowSeconds`, 0–100. */
    percent: number | null;
    windowSeconds: number | null;
    cores: number;
    level: SystemLevel;
  };
  load: { one: number; five: number; fifteen: number; perCore: number; level: SystemLevel } | null;
  memory: { totalBytes: number; availableBytes: number; usedPercent: number; level: SystemLevel } | null;
  disks: SystemDisk[];
  /** Time since the machine started, in seconds. */
  uptimeSeconds: number | null;
  app: {
    startedAt: string;
    uptimeSeconds: number;
    /** The app's process (resident memory). */
    rssBytes: number;
    /** The container's memory use and its limit (null: no limit), when the container lets the app read them. */
    container: { usedBytes: number; limitBytes: number | null; usedPercent: number | null; level: SystemLevel } | null;
  };
  /** The worst level above, for the line at the top. */
  level: SystemLevel;
}
