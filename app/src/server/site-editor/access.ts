import { existsSync, readFileSync } from 'node:fs';
import type { SiteEditorAccess } from '../../shared/site-editor.js';
import { writeFileDurable } from '../durable-file.js';
import type { SiteEditorConfig } from './config.js';

// Who may write and who may publish (2026-11-23), as the access administrators chose on the settings screen. Kept in
// `site-editor-access.json` in the mail folder (the app's backup copies it). Until the first save, the lists of
// site-editor.json apply (version 0).

export const SITE_EDITOR_ACCESS_FILE = 'site-editor-access.json';

interface Stored {
  version: number;
  editors: { everyone: boolean; departments: string[]; userIds: string[] };
  publishers: { departments: string[]; userIds: string[] };
  updatedAt: string;
  updatedBy: string;
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : []);

export class SiteEditorAccessStore {
  constructor(private readonly file: string) {}

  /** The saved choice, or null before the first save. A file that cannot be read counts as none (the config applies). */
  read(): Stored | null {
    if (!existsSync(this.file)) return null;
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, unknown>;
      const editors = (raw.editors ?? {}) as Record<string, unknown>;
      const publishers = (raw.publishers ?? {}) as Record<string, unknown>;
      if (typeof raw.version !== 'number' || raw.version < 1) return null;
      return {
        version: raw.version,
        editors: { everyone: editors.everyone === true, departments: strings(editors.departments), userIds: strings(editors.userIds) },
        publishers: { departments: strings(publishers.departments), userIds: strings(publishers.userIds) },
        updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : '',
        updatedBy: typeof raw.updatedBy === 'string' ? raw.updatedBy : '',
      };
    } catch {
      console.error(`${SITE_EDITOR_ACCESS_FILE} を読めないため、site-editor.json の書ける人・公開できる人を使います。`);
      return null;
    }
  }

  write(next: Omit<Stored, 'version'>, version: number): void {
    writeFileDurable(this.file, `${JSON.stringify({ ...next, version }, null, 2)}\n`);
  }
}

/** The lists that apply now: the saved choice, else the configuration's. */
export function effectiveAccess(config: SiteEditorConfig, store: SiteEditorAccessStore | null, nameOf: (userId: string) => string): SiteEditorAccess {
  const saved = store?.read() ?? null;
  if (saved) {
    return { editors: saved.editors, publishers: saved.publishers, version: saved.version, updatedAt: saved.updatedAt || null, updatedByName: saved.updatedBy ? nameOf(saved.updatedBy) : null };
  }
  return {
    editors: { everyone: config.editors.everyone, departments: config.editors.departments, userIds: config.editors.userIds },
    publishers: { departments: config.publishers.departments, userIds: config.publishers.userIds },
    version: 0,
    updatedAt: null,
    updatedByName: null,
  };
}
