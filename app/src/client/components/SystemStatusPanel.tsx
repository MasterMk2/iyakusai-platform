import { useCallback, useEffect, useRef, useState } from 'react';
import { SYSTEM_DISK_RESERVE_BYTES, SYSTEM_LEVEL_LABELS, SYSTEM_REFRESH_SECONDS, type SystemLevel, type SystemStatusResponse } from '../../shared/system';
import { api, fmtDate, toFailure } from '../api';
import { useLoader } from '../useLoader';
import { Facts } from './books/common';
import { LoadStatus } from './LoadStatus';
import './system-status.css';

// 設定 › サーバーの状態 (2026-11-21, access administrators): is anything wrong with the server right now, and where.
// The line at the top names what needs a look (§4: yellow 注意, red すぐ対応, no colour when fine); below it a meter
// per reading. Asked again every SYSTEM_REFRESH_SECONDS while this part is the one shown and the browser tab is
// visible: every part of the settings stays mounted, so a hidden one must not keep asking. A server without the
// route (404) or a person without the grant (403) takes the part off the list.

const STATUS_URL = '/api/system/status';
const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export function bytesLabel(n: number): string {
  if (n >= 100 * GiB) return `${Math.round(n / GiB)} GB`;
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GB`;
  if (n >= MiB) return `${Math.round(n / MiB)} MB`;
  return `${Math.max(0, Math.round(n / 1024))} KB`;
}

export function durationLabel(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  if (days > 0) return `${days} 日 ${hours} 時間`;
  if (hours > 0) return `${hours} 時間 ${minutes} 分`;
  return minutes > 0 ? `${minutes} 分` : '1 分未満';
}

const percentLabel = (p: number) => `${Math.round(p)}%`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** What is not fine, worst first, in words. */
export function findings(d: SystemStatusResponse): { level: SystemLevel; text: string }[] {
  const out: { level: SystemLevel; text: string }[] = [];
  if (d.cpu.level !== 'ok' && d.cpu.percent !== null) out.push({ level: d.cpu.level, text: `CPU の使用率が高い（${percentLabel(d.cpu.percent)}）` });
  if (d.memory && d.memory.level !== 'ok') out.push({ level: d.memory.level, text: `メモリの使用率が高い（${percentLabel(d.memory.usedPercent)}）` });
  const box = d.app.container;
  if (box && box.level !== 'ok' && box.usedPercent !== null) out.push({ level: box.level, text: `アプリのメモリが上限に近い（${percentLabel(box.usedPercent)}）` });
  for (const disk of d.disks) {
    if (disk.level === 'ok') continue;
    out.push({
      level: disk.level,
      text:
        disk.freeBytes < SYSTEM_DISK_RESERVE_BYTES
          ? // The minutes keep their recordings with the data: only that disk refuses them.
            `ディスク（${disk.label}）の空きが ${bytesLabel(disk.freeBytes)} しかない${disk.label.includes('データ') ? '（議事録の録音を取り込めません）' : ''}`
          : `ディスク（${disk.label}）の使用率が高い（${percentLabel(disk.usedPercent)}）`,
    });
  }
  if (d.load && d.load.level !== 'ok') out.push({ level: d.load.level, text: `負荷が高い（1 コアあたり ${d.load.perCore.toFixed(2)}）` });
  const rank = (l: SystemLevel) => (l === 'alert' ? 0 : l === 'warn' ? 1 : 2);
  return out.sort((a, b) => rank(a.level) - rank(b.level));
}

function LevelChip({ level }: { level: SystemLevel }) {
  if (level === 'ok') return null;
  return <span className={`chip system-chip ${level}`}>{SYSTEM_LEVEL_LABELS[level]}</span>;
}

function Meter({ name, label, percent, level, detail }: { name: string; label: string; percent: number | null; level: SystemLevel; detail: string }) {
  return (
    <div className="system-meter" data-meter={name} data-level={level}>
      <dt>{label}</dt>
      <dd className="system-bar-cell">
        {/* The number beside it says the same: the bar is for the eye only. */}
        <span className={`system-bar ${level}`} aria-hidden="true">
          <span style={{ width: `${percent === null ? 0 : Math.min(100, Math.max(0, percent))}%` }} />
        </span>
      </dd>
      <dd className="system-value">
        {percent === null ? '—' : percentLabel(percent)}
        <LevelChip level={level} />
      </dd>
      <dd className="system-detail">{detail}</dd>
    </div>
  );
}

export function SystemStatusPanel({ active, onAvailable }: { active: boolean; onAvailable?: (available: boolean) => void }) {
  const load = useCallback(async (signal: AbortSignal) => {
    try {
      return await api<SystemStatusResponse>('GET', STATUS_URL, undefined, signal);
    } catch (error) {
      const status = toFailure(error).status;
      if (status === 404 || status === 403) return null;
      throw error;
    }
  }, []);
  const loader = useLoader(load);
  const [latest, setLatest] = useState<SystemStatusResponse | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef(false);
  const receivedAt = useRef(0);
  const data = latest ?? loader.data;
  const absent = !loader.loading && !loader.error && !loader.data;
  const loaded = loader.data !== null;

  useEffect(() => {
    if (!loader.loading) onAvailable?.(!absent);
  }, [loader.loading, absent, onAvailable]);
  useEffect(() => {
    if (loader.data) receivedAt.current = Date.now();
  }, [loader.data]);

  const refresh = useCallback(async (signal?: AbortSignal) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const next = await api<SystemStatusResponse>('GET', STATUS_URL, undefined, signal);
      receivedAt.current = Date.now();
      setLatest(next);
      setRefreshError(null);
    } catch (error) {
      if (!signal?.aborted) setRefreshError(toFailure(error).message);
    } finally {
      inFlight.current = false;
      setRefreshing(false);
    }
  }, []);

  // Ask again while shown and the tab is visible; at once when it comes back after a while.
  useEffect(() => {
    if (!active || !loaded) return;
    const controller = new AbortController();
    const due = () => document.visibilityState === 'visible' && Date.now() - receivedAt.current >= (SYSTEM_REFRESH_SECONDS - 1) * 1000;
    const tick = () => {
      if (due()) void refresh(controller.signal);
    };
    tick();
    const timer = window.setInterval(tick, SYSTEM_REFRESH_SECONDS * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [active, loaded, refresh]);

  if (absent) return null;
  const issues = data ? findings(data) : [];
  const container = data?.app.container ?? null;

  return (
    <section className="admin system-status" aria-labelledby="system-status-title" data-testid="system-status">
      <h3 id="system-status-title">サーバーの状態</h3>
      <p className="hint">アプリが動いているサーバー全体の値です。この画面を開いているあいだ、{SYSTEM_REFRESH_SECONDS} 秒ごとに更新します。</p>
      <LoadStatus loader={loader} what="サーバーの状態" compact />
      {data && (
        <>
          <p className={`status ${data.level === 'alert' ? 'error' : data.level === 'warn' ? 'warning' : 'info'}`} role="status" data-testid="system-summary">
            {issues.length === 0 ? 'いまは問題ありません。' : `${SYSTEM_LEVEL_LABELS[data.level]}：${issues.map((i) => i.text).join('、')}`}
          </p>
          <div className="system-status-meta">
            <span data-testid="system-sampled-at">{clock(data.sampledAt)} 時点</span>
            <button type="button" className="secondary" onClick={() => void refresh()} disabled={refreshing}>
              {refreshing ? '更新中…' : '今すぐ更新'}
            </button>
          </div>
          {refreshError && (
            <p className="status warning" role="alert" data-testid="system-refresh-error">
              更新できませんでした（{refreshError}）。表示は {clock(data.sampledAt)} 時点の値です。
            </p>
          )}
          <dl className="system-meters">
            <Meter
              name="cpu"
              label="CPU"
              percent={data.cpu.percent}
              level={data.cpu.level}
              detail={data.cpu.percent === null ? 'この環境では取れません' : `${data.cpu.cores} コア・直近 ${Math.max(1, Math.round(data.cpu.windowSeconds ?? 0))} 秒の平均`}
            />
            {data.memory ? (
              <Meter
                name="memory"
                label="メモリ"
                percent={data.memory.usedPercent}
                level={data.memory.level}
                detail={`使用 ${bytesLabel(data.memory.totalBytes - data.memory.availableBytes)}／全体 ${bytesLabel(data.memory.totalBytes)}（空き ${bytesLabel(data.memory.availableBytes)}）`}
              />
            ) : (
              <Meter name="memory" label="メモリ" percent={null} level="ok" detail="この環境では取れません" />
            )}
            {data.disks.map((disk) => (
              <Meter
                key={disk.label}
                name={`disk:${disk.label}`}
                label={`ディスク（${disk.label}）`}
                percent={disk.usedPercent}
                level={disk.level}
                detail={`空き ${bytesLabel(disk.freeBytes)}／全体 ${bytesLabel(disk.totalBytes)}`}
              />
            ))}
            {container && container.limitBytes !== null && (
              <Meter
                name="app-memory"
                label="アプリのメモリ"
                percent={container.usedPercent}
                level={container.level}
                detail={`使用 ${bytesLabel(container.usedBytes)}／上限 ${bytesLabel(container.limitBytes)}`}
              />
            )}
          </dl>
          {data.disks.length === 0 && <p className="hint">ディスクの空きはこの環境では取れません。</p>}
          <h4>そのほか</h4>
          <Facts
            items={[
              [
                '負荷（1・5・15 分の平均）',
                data.load ? (
                  <>
                    {data.load.one.toFixed(2)}・{data.load.five.toFixed(2)}・{data.load.fifteen.toFixed(2)}（1 コアあたり {data.load.perCore.toFixed(2)}）
                    <LevelChip level={data.load.level} />
                  </>
                ) : (
                  'この環境では取れません'
                ),
              ],
              ['サーバーの稼働時間', data.uptimeSeconds === null ? 'この環境では取れません' : durationLabel(data.uptimeSeconds)],
              ['アプリの稼働時間', `${durationLabel(data.app.uptimeSeconds)}（${fmtDate(data.app.startedAt)} に起動）`],
              ['アプリのメモリ', container && container.limitBytes === null ? `${bytesLabel(container.usedBytes)}（上限なし）` : container ? null : bytesLabel(data.app.rssBytes)],
            ]}
          />
        </>
      )}
    </section>
  );
}
