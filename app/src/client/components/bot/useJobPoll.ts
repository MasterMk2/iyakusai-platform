import { useCallback, useEffect, useState } from 'react';
import type { AssistantJob } from '../../../shared/assistant';
import { api, type ApiFailure } from '../../api';
import { useLoader } from '../../useLoader';
import { isActive } from './common';

/** Seconds between two looks at a job that is still queued or running (../docs/contracts/bot-front.md §5). */
export const JOB_POLL_MS = 2_500;

/**
 * One job, read again while it is queued or running. Stops by itself at done, failed or canceled. A
 * failed look keeps the last state and offers reload (reload also restarts the polling).
 */
export function useJobPoll(jobId: string | null) {
  const [tick, setTick] = useState(0);
  const load = useCallback(
    (signal: AbortSignal) => {
      void tick;
      if (!jobId) return Promise.resolve(null);
      return api<{ job: AssistantJob }>('GET', `/api/assistant/jobs/${encodeURIComponent(jobId)}`, undefined, signal).then((answer) => answer.job);
    },
    [jobId, tick],
  );
  const loader = useLoader(load);
  // The last answer belongs to the job on screen only; a different job id never shows the old one.
  const job = jobId && loader.data && loader.data.id === jobId ? loader.data : null;
  const active = job !== null && isActive(job);
  useEffect(() => {
    if (!active) return;
    const timer = window.setTimeout(() => setTick((n) => n + 1), JOB_POLL_MS);
    return () => window.clearTimeout(timer);
  }, [active, job]);
  return {
    job,
    loading: loader.loading && jobId !== null,
    error: loader.error as ApiFailure | null,
    reload: () => setTick((n) => n + 1),
  };
}
