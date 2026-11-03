import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { DecisionDetailResponse, DecisionInput, DecisionListResponse, DecisionMetaResponse } from '../../../shared/decisions';

// The register's calls to the server. The meta answer (is the register on, may this person register) is read once
// per page load and shared; any failure reads as "off", so the entry points stay hidden.

export const decisionApi = {
  list: (query: URLSearchParams, signal?: AbortSignal) => api<DecisionListResponse>('GET', `/api/decisions?${query.toString()}`, undefined, signal),
  get: (id: string, signal?: AbortSignal) => api<DecisionDetailResponse>('GET', `/api/decisions/${encodeURIComponent(id)}`, undefined, signal),
  create: (body: DecisionInput & { clientToken: string }) => api<DecisionDetailResponse>('POST', '/api/decisions', body),
  update: (id: string, body: DecisionInput & { expectedVersion: number }) => api<DecisionDetailResponse>('PUT', `/api/decisions/${encodeURIComponent(id)}`, body),
  change: (id: string, body: DecisionInput & { expectedVersion: number; changeNote: string }) =>
    api<DecisionDetailResponse>('POST', `/api/decisions/${encodeURIComponent(id)}/change`, body),
  revoke: (id: string, body: { expectedVersion: number; note: string }) => api<DecisionDetailResponse>('POST', `/api/decisions/${encodeURIComponent(id)}/revoke`, body),
  restore: (id: string, body: { expectedVersion: number }) => api<DecisionDetailResponse>('POST', `/api/decisions/${encodeURIComponent(id)}/restore`, body),
};

const OFF: DecisionMetaResponse = { enabled: false, canRegister: false, canAdminister: false, departments: [] };

let metaRequest: Promise<DecisionMetaResponse> | null = null;

/** The meta answer, read once; a failed read is tried again the next time. */
export function loadDecisionMeta(): Promise<DecisionMetaResponse> {
  if (!metaRequest) {
    metaRequest = api<DecisionMetaResponse>('GET', '/api/decisions/meta').catch(() => {
      metaRequest = null;
      return OFF;
    });
  }
  return metaRequest;
}

/** After a registration the department keys in use may have changed: the next read asks again. */
export function forgetDecisionMeta(): void {
  metaRequest = null;
}

/** The meta answer on screen: null while it is read, then what the server says (OFF when it cannot be read). */
export function useDecisionMeta(): DecisionMetaResponse | null {
  const [meta, setMeta] = useState<DecisionMetaResponse | null>(null);
  useEffect(() => {
    let live = true;
    void loadDecisionMeta().then((m) => {
      if (live) setMeta(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return meta;
}
