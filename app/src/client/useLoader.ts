import { useEffect, useRef, useState } from 'react';
import { toFailure, type ApiFailure } from './api';

type Fetcher<T> = (signal: AbortSignal) => Promise<T>;

interface Settled<T> {
  fetcher: Fetcher<T>;
  attempt: number;
  outcome: 'ok' | 'error' | 'cancelled';
  error?: ApiFailure;
}

/**
 * Loads data for a memoized fetcher with explicit loading, error, retry and
 * cancel states. The last successful data is kept while reloading, after a
 * failure and after a cancel, so a failed or cancelled request never wipes
 * what the user was looking at.
 */
export function useLoader<T>(fetcher: Fetcher<T>) {
  const [attempt, setAttempt] = useState(0);
  const [data, setData] = useState<{ value: T; fetcher: Fetcher<T> } | null>(null);
  const [settled, setSettled] = useState<Settled<T> | null>(null);
  const controllerRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    fetcher(controller.signal).then(
      (value) => {
        if (controller.signal.aborted) return;
        setData({ value, fetcher });
        setSettled({ fetcher, attempt, outcome: 'ok' });
      },
      (err: unknown) => {
        if (controller.signal.aborted) return;
        setSettled({ fetcher, attempt, outcome: 'error', error: toFailure(err) });
      },
    );
    return () => controller.abort();
  }, [fetcher, attempt]);

  const current = settled && settled.fetcher === fetcher && settled.attempt === attempt ? settled : null;
  return {
    data: data?.value ?? null,
    dataIsCurrent: data?.fetcher === fetcher,
    loading: current === null,
    error: current?.outcome === 'error' ? (current.error ?? null) : null,
    cancelled: current?.outcome === 'cancelled',
    retry: () => setAttempt((a) => a + 1),
    cancel: () => {
      controllerRef.current?.abort();
      setSettled({ fetcher, attempt, outcome: 'cancelled' });
    },
  };
}
