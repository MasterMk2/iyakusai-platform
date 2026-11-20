import { useEffect, useState } from 'react';
import { SYSTEM_HEADER_REFRESH_SECONDS, SYSTEM_LEVEL_LABELS, type SystemStatusResponse } from '../../shared/system';
import { api, toFailure } from '../api';
import { findings } from './SystemStatusPanel';

// The server's state in the header (2026-11-21), on a PC only: a phone's header has no room, and every member's
// screen asking would add up. One line: 「サーバー正常 · CPU 23% · メモリ 31%」, or what needs a look (yellow 注意, red
// すぐ対応). It links to 設定 › サーバーの状態. Asked once a minute while the browser tab is visible; a server without
// it (404) or a person who may not see it (403, temporary staff) shows nothing and is not asked again.

/** Where the header has room beside the colour button and the signed-in name (styles.css: .server-badge). */
export const SERVER_BADGE_MEDIA = '(min-width: 1024px)';

function useWide(): boolean {
  const query = () => (typeof window.matchMedia === 'function' ? window.matchMedia(SERVER_BADGE_MEDIA) : null);
  const [wide, setWide] = useState(() => query()?.matches ?? false);
  useEffect(() => {
    const list = query();
    if (!list) return;
    const changed = () => setWide(list.matches);
    list.addEventListener('change', changed);
    return () => list.removeEventListener('change', changed);
  }, []);
  return wide;
}

const pct = (p: number) => `${Math.round(p)}%`;
const clock = (iso: string) => new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' });

export function ServerBadge() {
  const wide = useWide();
  const [data, setData] = useState<SystemStatusResponse | null>(null);
  const [stale, setStale] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    if (!wide || gone) return;
    const controller = new AbortController();
    let askedAt = 0;
    const ask = async () => {
      if (document.visibilityState !== 'visible' || Date.now() - askedAt < (SYSTEM_HEADER_REFRESH_SECONDS - 1) * 1000) return;
      askedAt = Date.now();
      try {
        setData(await api<SystemStatusResponse>('GET', '/api/system/status', undefined, controller.signal));
        setStale(false);
      } catch (error) {
        if (controller.signal.aborted) return;
        const status = toFailure(error).status;
        if (status === 401 || status === 403 || status === 404) setGone(true);
        else setStale(true);
      }
    };
    const tick = () => void ask();
    tick();
    const timer = window.setInterval(tick, SYSTEM_HEADER_REFRESH_SECONDS * 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      controller.abort();
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, [wide, gone]);

  if (!wide || gone || !data) return null;
  const issues = findings(data);
  const state = issues.length === 0 ? 'サーバー正常' : `${SYSTEM_LEVEL_LABELS[data.level]}：${issues[0]!.short}${issues.length > 1 ? ` ほか ${issues.length - 1} 件` : ''}`;
  const figures = [data.cpu.percent !== null ? `CPU ${pct(data.cpu.percent)}` : null, data.memory ? `メモリ ${pct(data.memory.usedPercent)}` : null].filter((f): f is string => f !== null);
  return (
    <a
      className={`server-badge ${data.level}${stale ? ' stale' : ''}`}
      href="#/settings/system"
      data-testid="server-badge"
      data-level={data.level}
      title={`${clock(data.sampledAt)} 時点${stale ? '（いまは取得できません）' : ''}。押すと「サーバーの状態」を開きます`}
    >
      <span className="server-badge-dot" aria-hidden="true" />
      <span className="server-badge-state">{state}</span>
      {issues.length === 0 &&
        figures.map((f) => (
          <span key={f} className="server-badge-figure">
            {f}
          </span>
        ))}
    </a>
  );
}
