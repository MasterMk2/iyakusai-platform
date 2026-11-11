import { useEffect, useState } from 'react';
import { api } from '../../api';
import type {
  BulletinDetailResponse,
  BulletinInput,
  BulletinList,
  BulletinListResponse,
  BulletinMetaResponse,
  BulletinReadResponse,
  BulletinSummaryResponse,
} from '../../../shared/bulletin';

// The notice board's calls to the server (its addresses inside the app are in shared/bulletin.ts). The meta answer (is the board on, the
// departments to choose from, today in Japan) is read once per page load and shared; a failure reads as "off".

export { BOARD_HREF, BOARD_NEW_HREF, boardPostHref } from '../../../shared/bulletin';

const post = (id: string) => `/api/bulletin/${encodeURIComponent(id)}`;

export const bulletinApi = {
  list: (list: BulletinList, page: number, pageSize: number, signal?: AbortSignal) => api<BulletinListResponse>('GET', `/api/bulletin?list=${list}&page=${page}&pageSize=${pageSize}`, undefined, signal),
  summary: (signal?: AbortSignal) => api<BulletinSummaryResponse>('GET', '/api/bulletin/summary', undefined, signal),
  get: (id: string, signal?: AbortSignal) => api<BulletinDetailResponse>('GET', post(id), undefined, signal),
  create: (body: BulletinInput & { clientToken: string }) => api<BulletinDetailResponse>('POST', '/api/bulletin', body),
  update: (id: string, body: BulletinInput & { expectedVersion: number; announce: boolean }) => api<BulletinDetailResponse>('PUT', post(id), body),
  withdraw: (id: string, expectedVersion: number) => api<BulletinDetailResponse>('POST', `${post(id)}/withdraw`, { expectedVersion }),
  restore: (id: string, expectedVersion: number) => api<BulletinDetailResponse>('POST', `${post(id)}/restore`, { expectedVersion }),
  read: (id: string) => api<BulletinReadResponse>('POST', `${post(id)}/read`, {}),
  readAll: () => api<BulletinReadResponse>('POST', '/api/bulletin/read-all', {}),
};

const OFF: BulletinMetaResponse = { enabled: false, canPost: false, departments: [], myDepartments: [], today: '' };

let metaRequest: Promise<BulletinMetaResponse> | null = null;

function loadBulletinMeta(): Promise<BulletinMetaResponse> {
  if (!metaRequest) {
    metaRequest = api<BulletinMetaResponse>('GET', '/api/bulletin/meta').catch(() => {
      metaRequest = null;
      return OFF;
    });
  }
  return metaRequest;
}

/** The meta answer on screen: null while it is read, then what the server says (off when it cannot be read). */
export function useBulletinMeta(): BulletinMetaResponse | null {
  const [meta, setMeta] = useState<BulletinMetaResponse | null>(null);
  useEffect(() => {
    let live = true;
    void loadBulletinMeta().then((m) => {
      if (live) setMeta(m);
    });
    return () => {
      live = false;
    };
  }, []);
  return meta;
}
