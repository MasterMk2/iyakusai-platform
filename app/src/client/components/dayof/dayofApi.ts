import { useCallback, useEffect, useRef, useState } from 'react';
import { dayofPollDelay, diffDayOfPosts, type DayOfAdminResponse, type DayOfBoardResponse, type DayOfPostInput, type DayOfPostView } from '../../../shared/dayof';
import { api, ApiFailure, toFailure } from '../../api';

// The festival-day board's calls to the server, and the home panel's reading of the board: once on opening, then
// every 30 seconds while the period is on and the page is visible, every 5 minutes outside the period (so a screen
// left open turns the panel on when the period begins); a hidden tab stops asking, and asks at once when it is shown
// again. One request answers the whole panel.

type Change = 'resolve' | 'reopen' | 'withdraw' | 'restore';
type PostAnswer = { post: DayOfPostView; revision: number };

export const dayofApi = {
  board: (signal?: AbortSignal) => api<DayOfBoardResponse>('GET', '/api/dayof/board', undefined, signal),
  create: (input: DayOfPostInput, clientToken: string) => api<PostAnswer & { replayed: boolean }>('POST', '/api/dayof/posts', { ...input, clientToken }),
  update: (id: string, input: DayOfPostInput, expectedVersion: number) => api<PostAnswer>('PUT', `/api/dayof/posts/${encodeURIComponent(id)}`, { ...input, expectedVersion }),
  change: (id: string, change: Change, expectedVersion: number) => api<PostAnswer>('POST', `/api/dayof/posts/${encodeURIComponent(id)}/${change}`, { expectedVersion }),
  decide: (body: { title: string; place: string; departments: string[]; clientToken: string }) => api<{ decisionId: string; replayed: boolean }>('POST', '/api/dayof/decisions', body),
  admin: (signal?: AbortSignal) => api<DayOfAdminResponse>('GET', '/api/dayof/admin', undefined, signal),
  saveSettings: (body: { startDate: string | null; endDate: string | null; rules: string; expectedVersion: number }) => api<DayOfAdminResponse>('PUT', '/api/dayof/admin/settings', body),
  setPoster: (body: { userId: string; on: boolean } | { department: string; on: boolean }) => api<DayOfAdminResponse>('PUT', '/api/dayof/admin/posters', body),
};

export interface DayOfBoardState {
  data: DayOfBoardResponse | null;
  /** The board is not for this person or this server (404, 403): the panel is left out. */
  hidden: boolean;
  loading: boolean;
  error: ApiFailure | null;
  /** When the shown data was read (ms). */
  readAt: number | null;
  /** 至急 notices that arrived (or became 至急) since the person last acknowledged them; they carry the 新着 mark. */
  newUrgent: string[];
  reload: () => void;
  acknowledge: () => void;
  /** A write of this person: its answer counts as seen, so it is not flagged as new on the next read. */
  noteOwn: (post: DayOfPostView) => void;
}

export function useDayOfBoard(refresh: number): DayOfBoardState {
  const [data, setData] = useState<DayOfBoardResponse | null>(null);
  const [hidden, setHidden] = useState(false);
  // The read that last answered (`refresh:tick`); a newer key means a read is on its way.
  const [settledKey, setSettledKey] = useState<string | null>(null);
  const [error, setError] = useState<ApiFailure | null>(null);
  const [readAt, setReadAt] = useState<number | null>(null);
  const [newUrgent, setNewUrgent] = useState<string[]>([]);
  const [tick, setTick] = useState(0);
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const seen = useRef<DayOfPostView[] | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    const key = `${refresh}:${tick}`;
    dayofApi.board(controller.signal).then(
      (next) => {
        if (controller.signal.aborted) return;
        const diff = diffDayOfPosts(seen.current, next.posts);
        seen.current = next.posts;
        if (diff.newUrgent.length > 0) setNewUrgent((list) => [...new Set([...list, ...diff.newUrgent])]);
        setData(next);
        setHidden(false);
        setError(null);
        setReadAt(Date.now());
        setSettledKey(key);
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        const failure = toFailure(err);
        if (failure.status === 404 || failure.status === 403) setHidden(true);
        setError(failure);
        setSettledKey(key);
      },
    );
    return () => controller.abort();
  }, [refresh, tick]);

  useEffect(() => {
    const onVisibility = () => {
      const now = document.visibilityState !== 'hidden';
      setVisible(now);
      if (now) setTick((t) => t + 1);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Polling while the page is seen: often in the period, seldom outside it, never for a board refused to this person.
  const delay = dayofPollDelay({ visible, refused: hidden, active: !!data?.active });
  useEffect(() => {
    if (delay === null) return;
    const timer = window.setInterval(() => setTick((t) => t + 1), delay);
    return () => window.clearInterval(timer);
  }, [delay]);

  const reload = useCallback(() => setTick((t) => t + 1), []);
  const acknowledge = useCallback(() => setNewUrgent([]), []);
  const noteOwn = useCallback((post: DayOfPostView) => {
    const list = seen.current ?? [];
    seen.current = list.some((p) => p.id === post.id) ? list.map((p) => (p.id === post.id ? post : p)) : [...list, post];
    setTick((t) => t + 1);
  }, []);

  const loading = settledKey !== `${refresh}:${tick}`;
  return { data, hidden, loading, error, readAt, newUrgent, reload, acknowledge, noteOwn };
}
